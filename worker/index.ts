interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_SETUP_TOKEN: string;
  SESSION_SECRET: string;
  ADMIN_ENCRYPTION_KEY: string;
}

type Board = "found" | "lost";
type Status = "stored" | "delivered" | "searching" | "found";
type ItemCategory = "지갑" | "가방" | "카드" | "전자기기" | "의류" | "도서/문구류" | "기타";
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
type CommentRow = {
  id: string;
  parent_comment_id: string | null;
  nickname: string;
  content: string;
  created_at: string;
  images: string;
};

const categories: ItemCategory[] = ["지갑", "가방", "카드", "전자기기", "의류", "도서/문구류", "기타"];
const profanityWords = [
  "씨발", "시발", "씨바", "쉬벌", "씹할", "씹새끼", "ㅆㅂ", "ㅅㅂ",
  "병신", "븅신", "ㅂㅅ", "좆", "좃", "존나", "졸라", "개새끼",
  "개자식", "새끼야", "미친놈", "미친년", "지랄", "염병", "꺼져",
  "닥쳐", "개같", "개소리", "느금마", "느개비", "fuck", "shit",
  "bitch", "asshole",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxImageBytes = 5 * 1024 * 1024;
const dayMs = 24 * 60 * 60 * 1000;

function json(data: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(data, { status, headers });
}

function fail(status: number, error: string) {
  return json({ error }, status);
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isBoard(value: unknown): value is Board {
  return value === "found" || value === "lost";
}

function isCategory(value: unknown): value is ItemCategory {
  return typeof value === "string" && categories.includes(value as ItemCategory);
}

function validStatus(board: Board, value: unknown): value is Status {
  return board === "found"
    ? value === "stored" || value === "delivered"
    : value === "searching" || value === "found";
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error("잘못된 비밀키 형식입니다.");
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function randomHex(bytes = 16) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toBase64Url(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizeModerationText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}\p{Z}\u200b\d]/gu, "");
}

async function containsBannedWord(db: D1Database, value: string) {
  const normalized = normalizeModerationText(value);
  if (profanityWords.some((word) => normalized.includes(normalizeModerationText(word)))) return true;
  const result = await db.prepare("SELECT word FROM banned_words").all<{ word: string }>();
  return result.results.some(({ word }) => normalized.includes(normalizeModerationText(word)));
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const digest = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 },
    key,
    256,
  );
  return `pbkdf2$310000$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(digest))}`;
}

async function verifyPassword(password: string, stored: string) {
  const [algorithm, iterationsValue, saltHex, expectedHex] = stored.split("$");
  if (algorithm !== "pbkdf2" || !iterationsValue || !saltHex || !expectedHex) return false;
  const iterations = Number(iterationsValue);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) return false;
  const salt = hexToBytes(saltHex);
  const expected = hexToBytes(expectedHex);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const actual = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    expected.length * 8,
  ));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

async function hmacKey(env: Env) {
  return crypto.subtle.importKey("raw", encoder.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(value: string, env: Env) {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(value));
  return toBase64Url(new Uint8Array(signature));
}

async function verifySignature(value: string, signature: string, env: Env) {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(env), fromBase64Url(signature), encoder.encode(value));
  } catch {
    return false;
  }
}

async function encryptUsername(username: string, env: Env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", hexToBytes(env.ADMIN_ENCRYPTION_KEY), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(username));
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

async function decryptUsername(value: string, env: Env) {
  const [ivHex, cipherHex] = value.split(":");
  if (!ivHex || !cipherHex) throw new Error("관리자 아이디 암호화 데이터가 올바르지 않습니다.");
  const key = await crypto.subtle.importKey("raw", hexToBytes(env.ADMIN_ENCRYPTION_KEY), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(ivHex) }, key, hexToBytes(cipherHex));
  return decoder.decode(plaintext);
}

async function usernameHash(username: string, env: Env) {
  return sign(username.normalize("NFKC"), env);
}

async function getAdmin(request: Request, env: Env) {
  const cookie = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("admin_session="))?.slice("admin_session=".length);
  if (!cookie) return null;
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || !(await verifySignature(payload, signature, env))) return null;
  let decoded: string;
  try {
    decoded = decoder.decode(fromBase64Url(payload));
  } catch {
    return null;
  }
  const [id, expiry] = decoded.split(":");
  if (id !== "1" || Number(expiry) <= Date.now()) return null;
  const admin = await env.DB.prepare("SELECT username_encrypted, password_changed_at FROM admin WHERE id = 1")
    .first<{ username_encrypted: string; password_changed_at: string | null }>();
  if (!admin) return null;
  return { username: await decryptUsername(admin.username_encrypted, env), passwordChangedAt: admin.password_changed_at };
}

async function requireAdmin(request: Request, env: Env, requireChanged = true) {
  const admin = await getAdmin(request, env);
  if (!admin) return { response: fail(401, "관리자 로그인이 필요합니다.") } as const;
  if (requireChanged && !admin.passwordChangedAt) {
    return { response: fail(428, "외부 공개 전에 관리자 비밀번호를 16자 이상으로 변경해 주세요.") } as const;
  }
  return { admin } as const;
}

function adminCookie(token: string, secure: boolean) {
  return `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? "; Secure" : ""}`;
}

async function newSession(adminId: number, env: Env) {
  const payload = toBase64Url(`${adminId}:${Date.now() + 12 * 60 * 60 * 1000}`);
  return `${payload}.${await sign(payload, env)}`;
}

async function allowRequest(request: Request, env: Env, scope: string, limit: number, windowMs: number) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits(key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END
    RETURNING count
  `).bind(key, now, now - windowMs, now - windowMs).first<{ count: number }>();
  if (Math.random() < 0.01) {
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 60 * 60 * 1000).run();
  }
  return (row?.count ?? 0) <= limit;
}

async function limitMutation(request: Request, env: Env) {
  return await allowRequest(request, env, "mutation", 30, 60_000)
    ? null
    : fail(429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
}

async function limitLogin(request: Request, env: Env) {
  return await allowRequest(request, env, "login", 10, 15 * 60_000)
    ? null
    : fail(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.");
}

async function readJson(request: Request) {
  if (Number(request.headers.get("Content-Length") ?? 0) > 100 * 1024) return null;
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readForm(request: Request) {
  if (Number(request.headers.get("Content-Length") ?? 0) > 16 * 1024 * 1024) return null;
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

async function getPhotos(form: FormData, allowPhotos: boolean) {
  const photos = form.getAll("photos");
  if (photos.some((photo) => !(photo instanceof File)) || photos.length > 3) {
    return { error: "사진 업로드 한도(최대 3장, 장당 5MB)를 확인해 주세요." } as const;
  }
  const files = photos as File[];
  if (!allowPhotos && files.length > 0) {
    return { error: "분실물 게시글 댓글에만 사진을 첨부할 수 있습니다." } as const;
  }
  const uploads: { key: string; url: string; file: File }[] = [];
  for (const file of files) {
    const extension = file.name.toLowerCase().split(".").pop();
    const expected = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "png" ? "image/png"
        : extension === "webp" ? "image/webp" : "";
    if (!expected || file.type !== expected || file.size > maxImageBytes || file.size === 0) {
      return { error: "JPG, PNG, WebP 이미지 파일만 등록할 수 있습니다. (장당 최대 5MB)" } as const;
    }
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const isWebp = bytes.length >= 12 && decoder.decode(bytes.slice(0, 4)) === "RIFF" && decoder.decode(bytes.slice(8, 12)) === "WEBP";
    if (!(expected === "image/jpeg" && isJpeg || expected === "image/png" && isPng || expected === "image/webp" && isWebp)) {
      return { error: "이미지 파일의 실제 형식을 확인할 수 없습니다." } as const;
    }
    const suffix = expected === "image/jpeg" ? (extension === "jpeg" ? "jpeg" : "jpg") : extension;
    const key = `${randomHex(18)}.${suffix}`;
    uploads.push({ key, url: `/uploads/${key}`, file });
  }
  return { uploads } as const;
}

async function saveUploads(env: Env, uploads: { key: string; file: File }[]) {
  try {
    for (const upload of uploads) {
      await env.BUCKET.put(upload.key, await upload.file.arrayBuffer(), {
        httpMetadata: { contentType: upload.file.type, cacheControl: "public, max-age=86400" },
      });
    }
  } catch (error) {
    await removeImages(env, uploads.map(({ key }) => key));
    throw error;
  }
}

async function removeImages(env: Env, urls: string[]) {
  const keys = [...new Set(urls.map((url) => url.split("/").pop()).filter((key): key is string => !!key && /^[a-f0-9]+\.(?:jpg|jpeg|png|webp)$/.test(key)))];
  if (keys.length) await env.BUCKET.delete(keys);
}

async function publicItem(env: Env, row: ItemRow) {
  const comments = await env.DB.prepare(`
    SELECT id, parent_comment_id, nickname, content, created_at, images
    FROM comments WHERE item_id = ? ORDER BY created_at, id
  `).bind(row.id).all<CommentRow>();
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
    comments: comments.results.map((comment) => ({
      id: comment.id,
      parentId: comment.parent_comment_id,
      nickname: comment.nickname,
      content: comment.content,
      createdAt: comment.created_at,
      images: JSON.parse(comment.images) as string[],
    })),
  };
}

async function getItem(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
}

function imageResponse(request: Request, env: Env, key: string) {
  return (async () => {
    if (!/^[a-f0-9]{36}\.(?:jpg|jpeg|png|webp)$/.test(key)) return fail(404, "사진을 찾을 수 없습니다.");
    const object = await env.BUCKET.get(key);
    if (!object) return fail(404, "사진을 찾을 수 없습니다.");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "public, max-age=86400");
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(object.body, { headers });
  })();
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ status: "ok" });

  if (path === "/api/items" && method === "GET") {
    const board = url.searchParams.get("board");
    if (!isBoard(board)) return fail(400, "게시판 종류가 올바르지 않습니다.");
    const query = text(url.searchParams.get("q"), 100).replace(/[\\%_]/g, "\\$&");
    const status = text(url.searchParams.get("status"), 20);
    const allowed = board === "found" ? ["stored", "delivered"] : ["searching", "found"];
    if (status && status !== "all" && !allowed.includes(status)) return fail(400, "진행 상태가 올바르지 않습니다.");
    const sort = url.searchParams.get("sort") === "oldest" ? "ASC" : "DESC";
    const where = ["board = ?"];
    const params: (string | number)[] = [board];
    if (status && status !== "all") {
      where.push("status = ?");
      params.push(status);
    }
    if (query) {
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(`%${query}%`, `%${query}%`);
    }
    const result = await env.DB.prepare(
      `SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY COALESCE(bumped_at, created_at) ${sort}`,
    ).bind(...params).all<ItemRow>();
    return json(await Promise.all(result.results.map((row) => publicItem(env, row))));
  }

  const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && method === "GET") {
    const row = await getItem(env, decodeURIComponent(itemMatch[1] ?? ""));
    return row ? json(await publicItem(env, row)) : fail(404, "게시글을 찾을 수 없습니다.");
  }

  if (path === "/api/items" && method === "POST") {
    const limited = await limitMutation(request, env);
    if (limited) return limited;
    const form = await readForm(request);
    if (!form) return fail(400, "게시글 정보를 확인해 주세요.");
    const photoResult = await getPhotos(form, true);
    if ("error" in photoResult && photoResult.error) return fail(400, photoResult.error);
    const board = form.get("board");
    if (!isBoard(board)) return fail(400, "게시판 종류가 올바르지 않습니다.");
    const title = text(form.get("title"), 60);
    const description = text(form.get("description"), 600);
    const category = form.get("category");
    const foundLocation = text(form.get("foundLocation"), 80);
    const storageLocation = text(form.get("storageLocation"), 80) || foundLocation;
    const nickname = text(form.get("nickname"), 20) || "익명";
    const password = typeof form.get("password") === "string" ? form.get("password") as string : "";
    const status = form.get("status") || (board === "found" ? "stored" : "searching");
    if (!title || !description || !isCategory(category) || password.length < 4 || password.length > 128 ||
      board === "found" && !foundLocation || !validStatus(board, status)) {
      return fail(400, "필수 항목을 확인해 주세요. 비밀번호는 4~128자입니다.");
    }
    if (await containsBannedWord(env.DB, `${title} ${description} ${foundLocation} ${storageLocation} ${nickname}`)) {
      return fail(400, "게시글에 사용할 수 없는 표현이 포함되어 있습니다.");
    }
    const id = randomHex();
    const createdAt = new Date().toISOString();
    await saveUploads(env, photoResult.uploads);
    try {
      await env.DB.prepare(`
        INSERT INTO items(id, board, title, description, category, found_location, storage_location, nickname,
          password_hash, status, created_at, images)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, board, title, description, category,
        board === "found" ? foundLocation : null,
        board === "found" ? storageLocation : null,
        nickname, await hashPassword(password), status, createdAt,
        JSON.stringify(photoResult.uploads.map(({ url }) => url)),
      ).run();
    } catch (error) {
      await removeImages(env, photoResult.uploads.map(({ key }) => key));
      throw error;
    }
    const row = await getItem(env, id);
    if (!row) throw new Error("게시글 저장 후 조회할 수 없습니다.");
    return json(await publicItem(env, row), 201);
  }

  if (itemMatch && method === "PATCH") {
    const limited = await limitMutation(request, env);
    if (limited) return limited;
    const body = await readJson(request);
    if (!body) return fail(400, "요청 정보를 확인해 주세요.");
    const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(decodeURIComponent(itemMatch[1]))
      .first<ItemRow & { password_hash: string }>();
    if (!row) return fail(404, "게시글을 찾을 수 없습니다.");
    if (typeof body.password !== "string" || !(await verifyPassword(body.password, row.password_hash))) {
      return fail(403, "게시글 비밀번호가 올바르지 않습니다.");
    }
    if (body.action === "bump") {
      const now = Date.now();
      if (row.bumped_at && now - new Date(row.bumped_at).getTime() < dayMs) {
        const remaining = Math.ceil((dayMs - (now - new Date(row.bumped_at).getTime())) / 3_600_000);
        return fail(429, `끌어올리기는 24시간에 한 번만 가능합니다. 약 ${remaining}시간 후 다시 시도해 주세요.`);
      }
      await env.DB.prepare("UPDATE items SET bumped_at = ? WHERE id = ?").bind(new Date(now).toISOString(), row.id).run();
    } else if (body.action === "status") {
      if (!validStatus(row.board, body.status)) return fail(400, "진행 상태가 올바르지 않습니다.");
      await env.DB.prepare("UPDATE items SET status = ? WHERE id = ?").bind(body.status, row.id).run();
    } else if (body.action === "edit") {
      const title = text(body.title, 60);
      const description = text(body.description, 600);
      const category = body.category;
      const foundLocation = text(body.foundLocation, 80);
      const storageLocation = text(body.storageLocation, 80) || foundLocation;
      const nickname = text(body.nickname, 20) || "익명";
      if (!title || !description || !isCategory(category) || row.board === "found" && !foundLocation) {
        return fail(400, "필수 항목을 입력해 주세요.");
      }
      if (await containsBannedWord(env.DB, `${title} ${description} ${foundLocation} ${storageLocation} ${nickname}`)) {
        return fail(400, "게시글에 사용할 수 없는 표현이 포함되어 있습니다.");
      }
      await env.DB.prepare(`
        UPDATE items SET title = ?, description = ?, category = ?, found_location = ?, storage_location = ?, nickname = ?
        WHERE id = ?
      `).bind(title, description, category, row.board === "found" ? foundLocation : null,
        row.board === "found" ? storageLocation : null, nickname, row.id).run();
    } else {
      return fail(400, "요청한 작업이 올바르지 않습니다.");
    }
    const updated = await getItem(env, row.id);
    if (!updated) throw new Error("게시글 변경 후 조회할 수 없습니다.");
    return json(await publicItem(env, updated));
  }

  if (itemMatch && method === "DELETE") {
    const limited = await limitMutation(request, env);
    if (limited) return limited;
    const body = await readJson(request);
    if (!body) return fail(400, "요청 정보를 확인해 주세요.");
    const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(decodeURIComponent(itemMatch[1]))
      .first<ItemRow & { password_hash: string }>();
    if (!row) return fail(404, "게시글을 찾을 수 없습니다.");
    if (typeof body.password !== "string" || !(await verifyPassword(body.password, row.password_hash))) {
      return fail(403, "게시글 비밀번호가 올바르지 않습니다.");
    }
    const commentImages = await env.DB.prepare("SELECT images FROM comments WHERE item_id = ?").bind(row.id).all<{ images: string }>();
    const images = [...JSON.parse(row.images) as string[], ...commentImages.results.flatMap(({ images }) => JSON.parse(images) as string[])];
    await removeImages(env, images);
    await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(row.id).run();
    return new Response(null, { status: 204 });
  }

  const commentsMatch = path.match(/^\/api\/items\/([^/]+)\/comments$/);
  if (commentsMatch && method === "POST") {
    const limited = await limitMutation(request, env);
    if (limited) return limited;
    const form = await readForm(request);
    if (!form) return fail(400, "댓글 정보를 확인해 주세요.");
    const item = await env.DB.prepare("SELECT id, board FROM items WHERE id = ?")
      .bind(decodeURIComponent(commentsMatch[1] ?? "")).first<{ id: string; board: Board }>();
    if (!item) return fail(404, "게시글을 찾을 수 없습니다.");
    const photoResult = await getPhotos(form, item.board === "lost");
    if ("error" in photoResult && photoResult.error) return fail(400, photoResult.error);
    const nickname = text(form.get("nickname"), 20) || "익명";
    const content = text(form.get("content"), 300);
    const password = typeof form.get("password") === "string" ? form.get("password") as string : "";
    const parentId = text(form.get("parentId"), 32) || null;
    if (!content || password.length < 4 || password.length > 128) {
      return fail(400, "댓글과 4~128자 비밀번호를 입력해 주세요.");
    }
    if (parentId && !await env.DB.prepare("SELECT id FROM comments WHERE id = ? AND item_id = ?")
      .bind(parentId, item.id).first()) return fail(400, "답글을 작성할 댓글을 찾을 수 없습니다.");
    if (await containsBannedWord(env.DB, `${content} ${nickname}`)) return fail(400, "댓글에 사용할 수 없는 표현이 포함되어 있습니다.");
    const id = randomHex();
    const createdAt = new Date().toISOString();
    await saveUploads(env, photoResult.uploads);
    try {
      await env.DB.prepare(`
        INSERT INTO comments(id, item_id, parent_comment_id, nickname, content, password_hash, created_at, images)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, item.id, parentId, nickname, content, await hashPassword(password), createdAt,
        JSON.stringify(photoResult.uploads.map(({ url }) => url))).run();
    } catch (error) {
      await removeImages(env, photoResult.uploads.map(({ key }) => key));
      throw error;
    }
    return json({
      id, parentId, nickname, content, createdAt, images: photoResult.uploads.map(({ url }) => url),
    }, 201);
  }

  const commentMatch = path.match(/^\/api\/comments\/([^/]+)$/);
  if (commentMatch && method === "DELETE") {
    const limited = await limitMutation(request, env);
    if (limited) return limited;
    const body = await readJson(request);
    if (!body) return fail(400, "요청 정보를 확인해 주세요.");
    const comment = await env.DB.prepare("SELECT password_hash FROM comments WHERE id = ?")
      .bind(decodeURIComponent(commentMatch[1])).first<{ password_hash: string }>();
    if (!comment) return fail(404, "댓글을 찾을 수 없습니다.");
    if (typeof body.password !== "string" || !(await verifyPassword(body.password, comment.password_hash))) {
      return fail(403, "댓글 비밀번호가 올바르지 않습니다.");
    }
    const subtree = await env.DB.prepare(`
      WITH RECURSIVE comment_tree(id, images) AS (
        SELECT id, images FROM comments WHERE id = ?
        UNION ALL
        SELECT child.id, child.images FROM comments child
        JOIN comment_tree parent ON child.parent_comment_id = parent.id
      )
      SELECT images FROM comment_tree
    `).bind(decodeURIComponent(commentMatch[1])).all<{ images: string }>();
    await removeImages(env, subtree.results.flatMap(({ images }) => JSON.parse(images) as string[]));
    await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(decodeURIComponent(commentMatch[1])).run();
    return new Response(null, { status: 204 });
  }

  if (path === "/api/admin/setup-status" && method === "GET") {
    const admin = await env.DB.prepare("SELECT 1 FROM admin LIMIT 1").first();
    return json({ setupRequired: !admin });
  }

  if (path === "/api/admin/setup" && method === "POST") {
    const limited = await limitLogin(request, env);
    if (limited) return limited;
    const body = await readJson(request);
    if (!body) return fail(400, "관리자 정보를 확인해 주세요.");
    if (await env.DB.prepare("SELECT 1 FROM admin LIMIT 1").first()) return fail(409, "관리자 계정이 이미 설정되어 있습니다.");
    if (body.setupToken !== env.ADMIN_SETUP_TOKEN) return fail(403, "관리자 설정 토큰이 올바르지 않습니다.");
    const username = text(body.username, 40);
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 12 || password.length > 128) {
      return fail(400, "아이디는 영문·숫자·._- 조합 3~40자, 비밀번호는 12~128자로 설정해 주세요.");
    }
    await env.DB.prepare("INSERT INTO admin(id, username_hash, username_encrypted, password_hash) VALUES (1, ?, ?, ?)")
      .bind(await usernameHash(username, env), await encryptUsername(username, env), await hashPassword(password)).run();
    return json({ username }, 200, {
      "Set-Cookie": adminCookie(await newSession(1, env), new URL(request.url).protocol === "https:"),
    });
  }

  if (path === "/api/admin/login" && method === "POST") {
    const limited = await limitLogin(request, env);
    if (limited) return limited;
    const body = await readJson(request);
    if (!body) return fail(400, "관리자 정보를 확인해 주세요.");
    const username = text(body.username, 40);
    const password = typeof body.password === "string" ? body.password : "";
    const admin = await env.DB.prepare("SELECT id, username_encrypted, password_hash FROM admin WHERE username_hash = ?")
      .bind(await usernameHash(username, env)).first<{ id: number; username_encrypted: string; password_hash: string }>();
    if (!admin || !(await verifyPassword(password, admin.password_hash))) return fail(401, "아이디 또는 비밀번호를 확인해 주세요.");
    return json({ username: await decryptUsername(admin.username_encrypted, env) }, 200, {
      "Set-Cookie": adminCookie(await newSession(admin.id, env), new URL(request.url).protocol === "https:"),
    });
  }

  if (path === "/api/admin/logout" && method === "POST") {
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return new Response(null, { status: 204, headers: { "Set-Cookie": `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` } });
  }

  if (path === "/api/admin/me" && method === "GET") {
    const auth = await requireAdmin(request, env, false);
    if ("response" in auth) return json({ authenticated: false });
    return json({ authenticated: true, username: auth.admin.username, needsPasswordChange: !auth.admin.passwordChangedAt });
  }

  if (path === "/api/admin/change-password" && method === "POST") {
    const limited = await limitMutation(request, env);
    if (limited) return limited;
    const auth = await requireAdmin(request, env, false);
    if ("response" in auth && auth.response) return auth.response;
    const body = await readJson(request);
    if (!body) return fail(400, "요청 정보를 확인해 주세요.");
    const admin = await env.DB.prepare("SELECT id, password_hash FROM admin WHERE username_hash = ?")
      .bind(await usernameHash(auth.admin.username, env)).first<{ id: number; password_hash: string }>();
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!admin || !(await verifyPassword(currentPassword, admin.password_hash))) return fail(403, "현재 비밀번호가 올바르지 않습니다.");
    if (newPassword.length < 16 || newPassword.length > 128) return fail(400, "새 비밀번호는 16~128자로 설정해 주세요.");
    await env.DB.prepare("UPDATE admin SET password_hash = ?, password_changed_at = ? WHERE id = ?")
      .bind(await hashPassword(newPassword), new Date().toISOString(), admin.id).run();
    return json({ changed: true });
  }

  const adminItemMatch = path.match(/^\/api\/admin\/items\/([^/]+)$/);
  if (path === "/api/admin/items" && method === "GET") {
    const auth = await requireAdmin(request, env);
    if ("response" in auth && auth.response) return auth.response;
    const result = await env.DB.prepare("SELECT * FROM items ORDER BY created_at DESC").all<ItemRow>();
    return json(await Promise.all(result.results.map((row) => publicItem(env, row))));
  }

  if (adminItemMatch && method === "PATCH") {
    const auth = await requireAdmin(request, env);
    if ("response" in auth && auth.response) return auth.response;
    const body = await readJson(request);
    if (!body) return fail(400, "요청 정보를 확인해 주세요.");
    const id = decodeURIComponent(adminItemMatch[1]);
    const row = await getItem(env, id);
    if (!row) return fail(404, "게시글을 찾을 수 없습니다.");
    if (!validStatus(row.board, body.status)) return fail(400, "진행 상태가 올바르지 않습니다.");
    await env.DB.prepare("UPDATE items SET status = ? WHERE id = ?").bind(body.status, id).run();
    const updated = await getItem(env, id);
    if (!updated) throw new Error("게시글 상태 변경 후 조회할 수 없습니다.");
    return json(await publicItem(env, updated));
  }

  if (adminItemMatch && method === "DELETE") {
    const auth = await requireAdmin(request, env);
    if ("response" in auth && auth.response) return auth.response;
    const id = decodeURIComponent(adminItemMatch[1]);
    const row = await getItem(env, id);
    if (!row) return fail(404, "게시글을 찾을 수 없습니다.");
    const comments = await env.DB.prepare("SELECT images FROM comments WHERE item_id = ?").bind(id).all<{ images: string }>();
    await removeImages(env, [
      ...JSON.parse(row.images) as string[],
      ...comments.results.flatMap(({ images }) => JSON.parse(images) as string[]),
    ]);
    await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
    return new Response(null, { status: 204 });
  }

  if (path === "/api/admin/banned-words" && method === "GET") {
    const auth = await requireAdmin(request, env);
    if ("response" in auth && auth.response) return auth.response;
    const words = await env.DB.prepare("SELECT word, created_at AS createdAt FROM banned_words ORDER BY word").all();
    return json(words.results);
  }

  if (path === "/api/admin/banned-words" && method === "POST") {
    const auth = await requireAdmin(request, env);
    if ("response" in auth && auth.response) return auth.response;
    const body = await readJson(request);
    if (!body) return fail(400, "금지어를 입력해 주세요.");
    const word = text(body.word, 40);
    if (normalizeModerationText(word).length < 2) return fail(400, "금지어는 2자 이상 입력해 주세요.");
    await env.DB.prepare("INSERT OR IGNORE INTO banned_words(word, created_at) VALUES (?, ?)")
      .bind(word, new Date().toISOString()).run();
    return json({ word }, 201);
  }

  const bannedWordMatch = path.match(/^\/api\/admin\/banned-words\/(.+)$/);
  if (bannedWordMatch && method === "DELETE") {
    const auth = await requireAdmin(request, env);
    if ("response" in auth && auth.response) return auth.response;
    await env.DB.prepare("DELETE FROM banned_words WHERE word = ?").bind(decodeURIComponent(bannedWordMatch[1])).run();
    return new Response(null, { status: 204 });
  }

  return fail(404, "요청한 주소를 찾을 수 없습니다.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = new Headers({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    });
    try {
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname.startsWith("/api/")) {
        response = await handleApi(request, env);
      } else if (url.pathname.startsWith("/uploads/") && (request.method === "GET" || request.method === "HEAD")) {
        response = await imageResponse(request, env, url.pathname.slice("/uploads/".length));
      } else {
        response = await env.ASSETS.fetch(request) ?? new Response("Not Found", { status: 404 });
      }
      const mergedHeaders = new Headers(response.headers);
      headers.forEach((value, key) => mergedHeaders.set(key, value));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: mergedHeaders });
    } catch (error) {
      console.error("Worker request failed:", error);
      return fail(500, "서버 오류가 발생했습니다.");
    }
  },
};
