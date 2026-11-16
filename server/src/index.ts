import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import express, { type NextFunction, type Request, type Response } from "express";
import * as tf from "@tensorflow/tfjs";
import { fileTypeFromFile } from "file-type";
import rateLimit from "express-rate-limit";
import multer from "multer";
import * as nsfwjs from "nsfwjs";
import sharp from "sharp";

const scrypt = promisify(nodeScrypt);
const root = process.cwd();
const dataDirectory = path.join(root, ".data");
const uploadsDirectory = path.join(dataDirectory, "uploads");
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
const production = process.env.NODE_ENV === "production";

await mkdir(uploadsDirectory, { recursive: true, mode: 0o700 });
await chmod(dataDirectory, 0o700);
const database = new Database(path.join(dataDirectory, "lostfound.sqlite"));
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    board TEXT NOT NULL CHECK (board IN ('found', 'lost')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '기타',
    found_location TEXT,
    storage_location TEXT,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    bumped_at TEXT,
    images TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    content TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    images TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username_hash TEXT NOT NULL UNIQUE,
    username_encrypted TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_changed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS banned_words (
    word TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_board_created ON items(board, created_at);
  CREATE INDEX IF NOT EXISTS comments_item_created ON comments(item_id, created_at);
`);
const itemColumns = database.pragma("table_info(items)") as { name: string }[];
if (!itemColumns.some(({ name }) => name === "category")) {
  database.exec("ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT '기타'");
}
database.prepare("UPDATE items SET category = '전자기기' WHERE category = '핸드폰'").run();
database.prepare("UPDATE items SET category = '기타' WHERE category = '열쇠'").run();
const commentColumns = database.pragma("table_info(comments)") as { name: string }[];
if (!commentColumns.some(({ name }) => name === "parent_comment_id")) {
  database.exec("ALTER TABLE comments ADD COLUMN parent_comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
}
if (!commentColumns.some(({ name }) => name === "images")) {
  database.exec("ALTER TABLE comments ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
}
if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config'").get()) {
  database.prepare("DELETE FROM config WHERE key IN ('signing_secret', 'admin_encryption_key')").run();
}

async function loadOrCreateSecret(filename: string, bytes: number) {
  const secretPath = path.join(dataDirectory, filename);
  try {
    const secret = await readFile(secretPath);
    if (secret.length !== bytes) throw new Error(`${filename} 파일 길이가 올바르지 않습니다.`);
    await chmod(secretPath, 0o600);
    return secret;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const secret = randomBytes(bytes);
    try {
      const handle = await open(secretPath, "wx", 0o600);
      try {
        await handle.writeFile(secret);
      } finally {
        await handle.close();
      }
      return secret;
    } catch (createError) {
      if (!(createError instanceof Error && "code" in createError && createError.code === "EEXIST")) throw createError;
      const existing = await readFile(secretPath);
      if (existing.length !== bytes) throw new Error(`${filename} 파일 길이가 올바르지 않습니다.`);
      await chmod(secretPath, 0o600);
      return existing;
    }
  }
}

const signingSecret = (await loadOrCreateSecret("session-signing.key", 48)).toString("hex");
const adminEncryptionKey = await loadOrCreateSecret("admin-encryption.key", 32);
const setupToken = randomBytes(24).toString("hex");

function hashUsername(username: string) {
  return createHmac("sha256", signingSecret).update(username.normalize("NFKC")).digest("hex");
}

function encryptUsername(username: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", adminEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(username, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")].join(":");
}

function decryptUsername(encrypted: string) {
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error("관리자 아이디 암호화 데이터가 올바르지 않습니다.");
  const decipher = createDecipheriv("aes-256-gcm", adminEncryptionKey, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

const adminColumns = database.pragma("table_info(admin)") as { name: string }[];
if (!adminColumns.some(({ name }) => name === "password_changed_at")) {
  database.exec("ALTER TABLE admin ADD COLUMN password_changed_at TEXT");
}
if (adminColumns.some(({ name }) => name === "username")) {
  const legacyAdmins = database.prepare("SELECT id, username, password_hash FROM admin").all() as {
    id: number;
    username: string;
    password_hash: string;
  }[];
  database.transaction(() => {
    database.exec("DROP TABLE admin");
    database.exec(`
      CREATE TABLE admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username_hash TEXT NOT NULL UNIQUE,
        username_encrypted TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_changed_at TEXT
      )
    `);
    const insertAdmin = database.prepare(
      "INSERT INTO admin(id, username_hash, username_encrypted, password_hash) VALUES (?, ?, ?, ?)",
    );
    for (const admin of legacyAdmins) {
      insertAdmin.run(admin.id, hashUsername(admin.username), encryptUsername(admin.username), admin.password_hash);
    }
  })();
}

if (!database.prepare("SELECT 1 FROM admin LIMIT 1").get()) {
  console.info(`Admin setup token (use once in the admin screen): ${setupToken}`);
}

let imageModel: nsfwjs.NSFWJS | null = null;
const imageModelReady = (async () => {
  await tf.setBackend("cpu");
  await tf.ready();
  imageModel = await nsfwjs.load();
  console.info("Local photo moderation model is ready.");
})().catch((error: unknown) => {
  console.error("Local photo moderation model failed to load; photo uploads will be rejected:", error);
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use("/uploads", express.static(uploadsDirectory, {
  fallthrough: false,
  maxAge: production ? "1d" : 0,
}));

const mutationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." },
});

type Board = "found" | "lost";
type Status = "stored" | "delivered" | "searching" | "found";
const itemCategories = ["지갑", "가방", "카드", "전자기기", "의류", "도서/문구류", "기타"] as const;
type ItemCategory = (typeof itemCategories)[number];
function isItemCategory(value: unknown): value is ItemCategory {
  return typeof value === "string" && itemCategories.includes(value as ItemCategory);
}
type ItemRow = {
  id: string;
  board: Board;
  title: string;
  description: string;
  category: ItemCategory;
  found_location: string | null;
  storage_location: string | null;
  nickname: string;
  status: Status;
  created_at: string;
  bumped_at: string | null;
  images: string;
};

function fail(response: Response, status: number, message: string) {
  response.status(status).json({ error: message });
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validStatus(board: Board, status: unknown): status is Status {
  return board === "found"
    ? status === "stored" || status === "delivered"
    : status === "searching" || status === "found";
}

function publicItem(row: ItemRow) {
  const comments = database
    .prepare("SELECT id, parent_comment_id, nickname, content, created_at, images FROM comments WHERE item_id = ? ORDER BY created_at, id")
    .all(row.id) as { id: string; parent_comment_id: string | null; nickname: string; content: string; created_at: string; images: string }[];
  return {
    id: row.id,
    board: row.board,
    title: row.title,
    description: row.description,
    category: row.category,
    ...(row.found_location ? { foundLocation: row.found_location } : {}),
    ...(row.storage_location ? { storageLocation: row.storage_location } : {}),
    nickname: row.nickname,
    status: row.status,
    createdAt: row.created_at,
    ...(row.bumped_at ? { lastBumpedAt: row.bumped_at } : {}),
    images: JSON.parse(row.images) as string[],
    comments: comments.map((comment) => ({
      id: comment.id,
      parentId: comment.parent_comment_id,
      nickname: comment.nickname,
      content: comment.content,
      createdAt: comment.created_at,
      images: JSON.parse(comment.images) as string[],
    })),
  };
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = (await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function sign(value: string) {
  return createHmac("sha256", signingSecret).update(value).digest("base64url");
}

function adminCookie(token: string) {
  return `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${production ? "; Secure" : ""}`;
}

function adminUsername(request: Request) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("admin_session="))?.slice("admin_session=".length);
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [adminId, expiry] = decoded.split(":");
  if (adminId !== "1" || Number(expiry) <= Date.now()) return null;
  const admin = database.prepare("SELECT username_encrypted FROM admin WHERE id = 1")
    .get() as { username_encrypted: string } | undefined;
  if (!admin) return null;
  return decryptUsername(admin.username_encrypted);
}

function requireAdmin(request: Request, response: Response, next: NextFunction) {
  const username = adminUsername(request);
  if (!username) return fail(response, 401, "관리자 로그인이 필요합니다.");
  const admin = database.prepare("SELECT password_changed_at FROM admin WHERE username_hash = ?")
    .get(hashUsername(username)) as { password_changed_at: string | null } | undefined;
  if (!admin?.password_changed_at) {
    return fail(response, 428, "외부 공개 전에 관리자 비밀번호를 16자 이상으로 변경해 주세요.");
  }
  next();
}

function requireAdminSession(request: Request, response: Response, next: NextFunction) {
  if (!adminUsername(request)) return fail(response, 401, "관리자 로그인이 필요합니다.");
  next();
}

const profanityWords = [
  "씨발", "시발", "씨바", "쉬벌", "씹할", "씹새끼", "ㅆㅂ", "ㅅㅂ",
  "병신", "븅신", "ㅂㅅ", "좆", "좃", "존나", "졸라", "개새끼",
  "개자식", "새끼야", "미친놈", "미친년", "지랄", "염병", "꺼져",
  "닥쳐", "개같", "개소리", "느금마", "느개비", "fuck", "shit",
  "bitch", "asshole",
];

function normalizeModerationText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}\p{Z}\u200b\d]/gu, "");
}

function containsBannedWord(value: string) {
  const normalized = normalizeModerationText(value);
  const profanity = profanityWords.find((word) => normalized.includes(normalizeModerationText(word)));
  if (profanity) return profanity;
  const words = database.prepare("SELECT word FROM banned_words").all() as { word: string }[];
  return words.find(({ word }) => normalized.includes(normalizeModerationText(word)))?.word;
}

async function classifyPhoto(filePath: string) {
  await imageModelReady;
  if (!imageModel) throw new Error("로컬 사진 검열 모델을 사용할 수 없습니다.");
  const { data, info } = await sharp(filePath)
    .rotate()
    .resize(224, 224, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels]);
  try {
    const predictions = await imageModel.classify(pixels);
    return predictions.some((prediction: nsfwjs.PredictionType) =>
      (prediction.className === "Porn" || prediction.className === "Hentai") && prediction.probability >= 0.55 ||
      prediction.className === "Sexy" && prediction.probability >= 0.7,
    );
  } finally {
    pixels.dispose();
  }
}

let moderationQueue = Promise.resolve();
function moderatePhoto(filePath: string) {
  const result = moderationQueue.then(() => classifyPhoto(filePath));
  moderationQueue = result.then(() => undefined, () => undefined);
  return result;
}

const storage = multer.diskStorage({
  destination: uploadsDirectory,
  filename: (_request, file, callback) => {
    callback(null, `${randomBytes(18).toString("hex")}${path.extname(file.originalname).toLowerCase()}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const allowed = new Map([
      [".jpg", "image/jpeg"],
      [".jpeg", "image/jpeg"],
      [".png", "image/png"],
      [".webp", "image/webp"],
    ]);
    if (allowed.get(extension) !== file.mimetype) {
      callback(new Error("JPG, PNG, WebP 이미지 파일만 등록할 수 있습니다."));
      return;
    }
    callback(null, true);
  },
});

function removeUploaded(files: Express.Multer.File[] | undefined) {
  if (!files) return Promise.resolve();
  return Promise.all(files.map((file) => unlink(file.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  }))).then(() => undefined);
}

async function removeImageUrls(images: string[]) {
  await Promise.all(images.map(async (url) => {
    const filename = path.basename(url);
    await unlink(path.join(uploadsDirectory, filename)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }));
}

app.get("/api/health", (_request, response) => response.json({ status: "ok" }));

app.get("/api/items", (request, response) => {
  const board = request.query.board;
  if (board !== "found" && board !== "lost") return fail(response, 400, "게시판 종류가 올바르지 않습니다.");
  const query = text(request.query.q, 100);
  const status = text(request.query.status, 20);
  const sort = request.query.sort === "oldest" ? "ASC" : "DESC";
  const allowedStatuses = board === "found" ? ["stored", "delivered"] : ["searching", "found"];
  if (status && status !== "all" && !allowedStatuses.includes(status)) {
    return fail(response, 400, "진행 상태가 올바르지 않습니다.");
  }
  const params: string[] = [board];
  let where = "board = ?";
  if (status && status !== "all") {
    where += " AND status = ?";
    params.push(status);
  }
  if (query) {
    where += " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
    const escaped = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(escaped, escaped);
  }
  const rows = database.prepare(
    `SELECT * FROM items WHERE ${where} ORDER BY COALESCE(bumped_at, created_at) ${sort}`,
  ).all(...params) as ItemRow[];
  response.json(rows.map(publicItem));
});

app.get("/api/items/:id", (request, response) => {
  const row = database.prepare("SELECT * FROM items WHERE id = ?").get(request.params.id) as ItemRow | undefined;
  if (!row) return fail(response, 404, "게시글을 찾을 수 없습니다.");
  response.json(publicItem(row));
});

app.post("/api/items", mutationLimiter, (request, response, next) => {
  upload.array("photos", 3)(request, response, (error) => {
    if (error) {
      void removeUploaded(request.files as Express.Multer.File[] | undefined)
        .then(() => next(error))
        .catch(next);
      return;
    }
    void (async () => {
      const body = request.body as Record<string, unknown>;
      const board = body.board;
      const files = (request.files ?? []) as Express.Multer.File[];
      const verifiedImages = await Promise.all(files.map((file) => fileTypeFromFile(file.path)));
      const expectedMime = (file: Express.Multer.File) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
        if (extension === ".png") return "image/png";
        if (extension === ".webp") return "image/webp";
        return "";
      };
      if (verifiedImages.some((type, index) => !type || type.mime !== expectedMime(files[index]))) {
        await removeUploaded(files);
        return fail(response, 400, "이미지 파일의 실제 형식을 확인할 수 없습니다.");
      }
      try {
        for (const file of files) {
          if (await moderatePhoto(file.path)) {
            await removeUploaded(files);
            return fail(response, 400, "사진 검열 기준에 해당하는 이미지가 포함되어 있습니다.");
          }
        }
      } catch (error) {
        await removeUploaded(files);
        console.error("Local photo moderation failed:", error);
        return fail(response, 503, "사진 검열을 완료할 수 없어 등록을 중단했습니다.");
      }
      if (board !== "found" && board !== "lost") {
        await removeUploaded(files);
        return fail(response, 400, "게시판 종류가 올바르지 않습니다.");
      }
      const title = text(body.title, 60);
      const description = text(body.description, 600);
      const category = body.category;
      const foundLocation = text(body.foundLocation, 80);
      const storageLocation = text(body.storageLocation, 80) || foundLocation;
      const nickname = text(body.nickname, 20) || "익명";
      const password = typeof body.password === "string" ? body.password : "";
      const status = body.status || (board === "found" ? "stored" : "searching");
      if (!title || !description || !isItemCategory(category) ||
        password.length < 4 || password.length > 128 ||
        (board === "found" && !foundLocation) || !validStatus(board, status)) {
        await removeUploaded(files);
        return fail(response, 400, "필수 항목을 확인해 주세요. 비밀번호는 4~128자입니다.");
      }
      if (containsBannedWord(`${title} ${description} ${foundLocation} ${storageLocation} ${nickname}`)) {
        await removeUploaded(files);
        return fail(response, 400, "게시글에 사용할 수 없는 표현이 포함되어 있습니다.");
      }
      const id = randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      const passwordHash = await hashPassword(password);
      database.prepare(`
        INSERT INTO items(id, board, title, description, category, found_location, storage_location, nickname,
          password_hash, status, created_at, images)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, board, title, description, category, board === "found" ? foundLocation : null,
        board === "found" ? storageLocation : null, nickname, passwordHash, status, createdAt,
        JSON.stringify(files.map((file) => `/uploads/${file.filename}`)));
      response.status(201).json(publicItem(database.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow));
    })().catch(next);
  });
});

app.patch("/api/items/:id", mutationLimiter, async (request, response, next) => {
  try {
    const body = request.body as Record<string, unknown>;
    const row = database.prepare("SELECT * FROM items WHERE id = ?").get(request.params.id) as (ItemRow & { password_hash: string }) | undefined;
    if (!row) return fail(response, 404, "게시글을 찾을 수 없습니다.");
    if (typeof body.password !== "string" || !(await verifyPassword(body.password, row.password_hash))) {
      return fail(response, 403, "게시글 비밀번호가 올바르지 않습니다.");
    }
    if (body.action === "bump") {
      const now = Date.now();
      if (row.bumped_at && now - new Date(row.bumped_at).getTime() < 24 * 60 * 60 * 1000) {
        const remaining = Math.ceil((24 * 60 * 60 * 1000 - (now - new Date(row.bumped_at).getTime())) / 3_600_000);
        return fail(response, 429, `끌어올리기는 24시간에 한 번만 가능합니다. 약 ${remaining}시간 후 다시 시도해 주세요.`);
      }
      database.prepare("UPDATE items SET bumped_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
    } else if (body.action === "status") {
      if (!validStatus(row.board, body.status)) return fail(response, 400, "진행 상태가 올바르지 않습니다.");
      database.prepare("UPDATE items SET status = ? WHERE id = ?").run(body.status, row.id);
    } else if (body.action === "edit") {
      const title = text(body.title, 60);
      const description = text(body.description, 600);
      const category = body.category;
      const foundLocation = text(body.foundLocation, 80);
      const storageLocation = text(body.storageLocation, 80) || foundLocation;
      const nickname = text(body.nickname, 20) || "익명";
      if (!title || !description || !isItemCategory(category) ||
        (row.board === "found" && !foundLocation)) return fail(response, 400, "필수 항목을 입력해 주세요.");
      if (containsBannedWord(`${title} ${description} ${foundLocation} ${storageLocation} ${nickname}`)) return fail(response, 400, "게시글에 사용할 수 없는 표현이 포함되어 있습니다.");
      database.prepare("UPDATE items SET title = ?, description = ?, category = ?, found_location = ?, storage_location = ?, nickname = ? WHERE id = ?")
        .run(title, description, category, row.board === "found" ? foundLocation : null, row.board === "found" ? storageLocation : null, nickname, row.id);
    } else {
      return fail(response, 400, "요청한 작업이 올바르지 않습니다.");
    }
    response.json(publicItem(database.prepare("SELECT * FROM items WHERE id = ?").get(row.id) as ItemRow));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/items/:id", mutationLimiter, async (request, response, next) => {
  try {
    const row = database.prepare("SELECT * FROM items WHERE id = ?").get(request.params.id) as (ItemRow & { password_hash: string }) | undefined;
    if (!row) return fail(response, 404, "게시글을 찾을 수 없습니다.");
    const password = request.body?.password;
    if (typeof password !== "string" || !(await verifyPassword(password, row.password_hash))) {
      return fail(response, 403, "게시글 비밀번호가 올바르지 않습니다.");
    }
    const commentImages = database.prepare("SELECT images FROM comments WHERE item_id = ?")
      .all(row.id) as { images: string }[];
    await removeImageUrls([
      ...(JSON.parse(row.images) as string[]),
      ...commentImages.flatMap(({ images }) => JSON.parse(images) as string[]),
    ]);
    database.prepare("DELETE FROM items WHERE id = ?").run(row.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/items/:id/comments", mutationLimiter, (request, response, next) => {
  upload.array("photos", 3)(request, response, (error) => {
    const files = (request.files ?? []) as Express.Multer.File[];
    if (error) {
      void removeUploaded(files).then(() => next(error)).catch(next);
      return;
    }
    void (async () => {
      const item = database.prepare("SELECT id, board FROM items WHERE id = ?")
        .get(request.params.id) as { id: string; board: Board } | undefined;
      if (!item) {
        await removeUploaded(files);
        return fail(response, 404, "게시글을 찾을 수 없습니다.");
      }
      if (item.board !== "lost" && files.length > 0) {
        await removeUploaded(files);
        return fail(response, 400, "분실물 게시글 댓글에만 사진을 첨부할 수 있습니다.");
      }
      const verifiedImages = await Promise.all(files.map((file) => fileTypeFromFile(file.path)));
      const expectedMime = (file: Express.Multer.File) => {
        const extension = path.extname(file.originalname).toLowerCase();
        if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
        if (extension === ".png") return "image/png";
        if (extension === ".webp") return "image/webp";
        return "";
      };
      if (verifiedImages.some((type, index) => !type || type.mime !== expectedMime(files[index]))) {
        await removeUploaded(files);
        return fail(response, 400, "이미지 파일의 실제 형식을 확인할 수 없습니다.");
      }
      try {
        for (const file of files) {
          if (await moderatePhoto(file.path)) {
            await removeUploaded(files);
            return fail(response, 400, "사진 검열 기준에 해당하는 이미지가 포함되어 있습니다.");
          }
        }
      } catch (moderationError) {
        await removeUploaded(files);
        console.error("Local comment photo moderation failed:", moderationError);
        return fail(response, 503, "사진 검열을 완료할 수 없어 댓글 등록을 중단했습니다.");
      }
      const nickname = text(request.body?.nickname, 20) || "익명";
      const content = text(request.body?.content, 300);
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const parentId = text(request.body?.parentId, 32) || null;
      if (!content || password.length < 4 || password.length > 128) {
        await removeUploaded(files);
        return fail(response, 400, "댓글과 4~128자 비밀번호를 입력해 주세요.");
      }
      if (parentId && !database.prepare("SELECT id FROM comments WHERE id = ? AND item_id = ?")
        .get(parentId, item.id)) {
        await removeUploaded(files);
        return fail(response, 400, "답글을 작성할 댓글을 찾을 수 없습니다.");
      }
      if (containsBannedWord(`${content} ${nickname}`)) {
        await removeUploaded(files);
        return fail(response, 400, "댓글에 사용할 수 없는 표현이 포함되어 있습니다.");
      }
      const id = randomBytes(16).toString("hex");
      const createdAt = new Date().toISOString();
      const images = files.map((file) => `/uploads/${file.filename}`);
      database.prepare(`
        INSERT INTO comments(id, item_id, parent_comment_id, nickname, content, password_hash, created_at, images)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, item.id, parentId, nickname, content, await hashPassword(password), createdAt, JSON.stringify(images));
      response.status(201).json({ id, parentId, nickname, content, createdAt, images });
    })().catch(async (reason: unknown) => {
      await removeUploaded(files);
      next(reason);
    });
  });
});

app.delete("/api/comments/:id", mutationLimiter, async (request, response, next) => {
  try {
    const comment = database.prepare("SELECT password_hash FROM comments WHERE id = ?").get(request.params.id) as { password_hash: string } | undefined;
    if (!comment) return fail(response, 404, "댓글을 찾을 수 없습니다.");
    const password = request.body?.password;
    if (typeof password !== "string" || !(await verifyPassword(password, comment.password_hash))) {
      return fail(response, 403, "댓글 비밀번호가 올바르지 않습니다.");
    }
    const subtree = database.prepare(`
      WITH RECURSIVE comment_tree(id, images) AS (
        SELECT id, images FROM comments WHERE id = ?
        UNION ALL
        SELECT child.id, child.images FROM comments child
        JOIN comment_tree parent ON child.parent_comment_id = parent.id
      )
      SELECT images FROM comment_tree
    `).all(request.params.id) as { images: string }[];
    await removeImageUrls(subtree.flatMap(({ images }) => JSON.parse(images) as string[]));
    database.prepare("DELETE FROM comments WHERE id = ?").run(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/setup", loginLimiter, async (request, response, next) => {
  try {
    if (database.prepare("SELECT 1 FROM admin LIMIT 1").get()) return fail(response, 409, "관리자 계정이 이미 설정되어 있습니다.");
    if (request.body?.setupToken !== setupToken) return fail(response, 403, "관리자 설정 토큰이 올바르지 않습니다.");
    const username = text(request.body?.username, 40);
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 12 || password.length > 128) {
      return fail(response, 400, "아이디는 영문·숫자·._- 조합 3~40자, 비밀번호는 12~128자로 설정해 주세요.");
    }
    database.prepare("INSERT INTO admin(id, username_hash, username_encrypted, password_hash) VALUES (1, ?, ?, ?)")
      .run(hashUsername(username), encryptUsername(username), await hashPassword(password));
    const payload = Buffer.from(`1:${Date.now() + 12 * 60 * 60 * 1000}`).toString("base64url");
    response.setHeader("Set-Cookie", adminCookie(`${payload}.${sign(payload)}`));
    response.json({ username });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/setup-status", (_request, response) => {
  response.json({ setupRequired: !database.prepare("SELECT 1 FROM admin LIMIT 1").get() });
});

app.post("/api/admin/login", loginLimiter, async (request, response, next) => {
  try {
    const username = text(request.body?.username, 40);
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    const admin = database.prepare("SELECT id, username_encrypted, password_hash FROM admin WHERE username_hash = ?")
      .get(hashUsername(username)) as { id: number; username_encrypted: string; password_hash: string } | undefined;
    if (!admin || !(await verifyPassword(password, admin.password_hash))) return fail(response, 401, "아이디 또는 비밀번호를 확인해 주세요.");
    const payload = Buffer.from(`${admin.id}:${Date.now() + 12 * 60 * 60 * 1000}`).toString("base64url");
    response.setHeader("Set-Cookie", adminCookie(`${payload}.${sign(payload)}`));
    response.json({ username: decryptUsername(admin.username_encrypted) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/logout", (_request, response) => {
  response.setHeader("Set-Cookie", `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`);
  response.status(204).end();
});

app.post("/api/admin/change-password", mutationLimiter, requireAdminSession, async (request, response, next) => {
  try {
    const username = adminUsername(request);
    const currentPassword = typeof request.body?.currentPassword === "string" ? request.body.currentPassword : "";
    const newPassword = typeof request.body?.newPassword === "string" ? request.body.newPassword : "";
    const admin = username
      ? database.prepare("SELECT id, password_hash FROM admin WHERE username_hash = ?")
          .get(hashUsername(username)) as { id: number; password_hash: string } | undefined
      : undefined;
    if (!admin || !(await verifyPassword(currentPassword, admin.password_hash))) {
      return fail(response, 403, "현재 비밀번호가 올바르지 않습니다.");
    }
    if (newPassword.length < 16 || newPassword.length > 128) {
      return fail(response, 400, "새 비밀번호는 16~128자로 설정해 주세요.");
    }
    database.prepare("UPDATE admin SET password_hash = ?, password_changed_at = ? WHERE id = ?")
      .run(await hashPassword(newPassword), new Date().toISOString(), admin.id);
    response.json({ changed: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/me", (request, response) => {
  const username = adminUsername(request);
  if (!username) return response.json({ authenticated: false });
  const admin = database.prepare("SELECT password_changed_at FROM admin WHERE username_hash = ?")
    .get(hashUsername(username)) as { password_changed_at: string | null } | undefined;
  response.json({
    authenticated: true,
    username,
    needsPasswordChange: !admin?.password_changed_at,
  });
});

app.get("/api/admin/items", requireAdmin, (_request, response) => {
  const rows = database.prepare("SELECT * FROM items ORDER BY created_at DESC").all() as ItemRow[];
  response.json(rows.map(publicItem));
});

app.patch("/api/admin/items/:id", requireAdmin, (request, response) => {
  const row = database.prepare("SELECT * FROM items WHERE id = ?").get(request.params.id) as ItemRow | undefined;
  if (!row) return fail(response, 404, "게시글을 찾을 수 없습니다.");
  if (!validStatus(row.board, request.body?.status)) return fail(response, 400, "진행 상태가 올바르지 않습니다.");
  database.prepare("UPDATE items SET status = ? WHERE id = ?").run(request.body.status, row.id);
  response.json(publicItem(database.prepare("SELECT * FROM items WHERE id = ?").get(row.id) as ItemRow));
});

app.delete("/api/admin/items/:id", requireAdmin, async (request, response, next) => {
  try {
    const row = database.prepare("SELECT images FROM items WHERE id = ?").get(request.params.id) as { images: string } | undefined;
    if (!row) return fail(response, 404, "게시글을 찾을 수 없습니다.");
    await removeImageUrls(JSON.parse(row.images) as string[]);
    database.prepare("DELETE FROM items WHERE id = ?").run(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/banned-words", requireAdmin, (_request, response) => {
  response.json(database.prepare("SELECT word, created_at AS createdAt FROM banned_words ORDER BY word").all());
});

app.post("/api/admin/banned-words", requireAdmin, (request, response) => {
  const word = text(request.body?.word, 40);
  if (normalizeModerationText(word).length < 2) return fail(response, 400, "금지어는 2자 이상 입력해 주세요.");
  database.prepare("INSERT OR IGNORE INTO banned_words(word, created_at) VALUES (?, ?)").run(word, new Date().toISOString());
  response.status(201).json({ word });
});

app.delete("/api/admin/banned-words/:word", requireAdmin, (request, response) => {
  database.prepare("DELETE FROM banned_words WHERE word = ?").run(request.params.word);
  response.status(204).end();
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (error instanceof multer.MulterError) return fail(response, 400, "사진 업로드 한도(최대 3장, 장당 5MB)를 확인해 주세요.");
  if (error instanceof Error && error.message.includes("이미지 파일")) return fail(response, 400, error.message);
  fail(response, 500, "서버 오류가 발생했습니다.");
});

if (production) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*path", (_request, response) => response.sendFile(path.join(root, "dist", "index.html")));
}

app.listen(port, host, () => {
  console.info(`Lost & Found server listening on http://${host}:${port}`);
  if (!database.prepare("SELECT 1 FROM admin LIMIT 1").get()) {
    console.info("Use the setup token above in the admin screen to create the first admin.");
  }
});
