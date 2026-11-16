import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class MockSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }
  setName(name) {
    this.name = name;
  }
  appendRow(row) {
    this.rows.push([...row]);
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows[0]?.length ?? 0;
  }
  getDataRange() {
    return { getValues: () => this.rows.map((row) => [...row]) };
  }
  getRange(row, column, rowCount = 1, columnCount = this.getLastColumn()) {
    return {
      getValues: () => this.rows.slice(row - 1, row - 1 + rowCount)
        .map((values) => values.slice(column - 1, column - 1 + columnCount)),
      setValues: (values) => {
        this.rows[row - 1] = [...values[0]];
      },
    };
  }
  deleteRow(row) {
    this.rows.splice(row - 1, 1);
  }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = [new MockSheet("Sheet1")];
  }
  getId() {
    return "sheet-id";
  }
  getUrl() {
    return "https://docs.google.com/spreadsheets/d/sheet-id";
  }
  getSheets() {
    return this.sheets;
  }
  getSheetByName(name) {
    return this.sheets.find((sheet) => sheet.name === name) ?? null;
  }
  insertSheet(name) {
    const sheet = new MockSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
}

async function createAppsScriptContext() {
  const properties = new Map();
  const spreadsheets = new Map();
  const folders = new Map();
  const files = new Map();
  let uuid = 0;
  const utilities = {
    DigestAlgorithm: { SHA_256: "sha256" },
    getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    computeDigest: (_algorithm, bytes) => [...createHash("sha256").update(Buffer.from(bytes)).digest()],
    computeHmacSha256Signature: (value, key) => [
      ...createHmac("sha256", Buffer.from(key)).update(Buffer.from(value)).digest(),
    ],
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString("base64url"),
    base64Decode: (value) => [...Buffer.from(value, "base64")],
    newBlob: (value) => ({ getBytes: () => [...Buffer.from(value)] }),
  };
  const context = {
    console,
    Date,
    Math,
    JSON,
    String,
    Object,
    Array,
    Number,
    RegExp,
    Error,
    Utilities: utilities,
    Logger: { log() {} },
    ContentService: {
      MimeType: { JSON: "application/json", TEXT: "text/plain" },
      createTextOutput: (content) => ({
        content,
        setMimeType() { return this; },
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) ?? null,
        setProperty: (key, value) => properties.set(key, value),
        deleteProperty: (key) => properties.delete(key),
      }),
    },
    SpreadsheetApp: {
      create: () => {
        const spreadsheet = new MockSpreadsheet();
        spreadsheets.set("sheet-id", spreadsheet);
        return spreadsheet;
      },
      openById: (id) => {
        const spreadsheet = spreadsheets.get(id);
        if (!spreadsheet) throw new Error("Missing mock spreadsheet");
        return spreadsheet;
      },
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: "anyone" },
      Permission: { VIEW: "view" },
      createFolder: () => {
        const folder = {
          getId: () => "folder-id",
          createFile: (blob) => {
            const id = randomUUID();
            const file = {
              getId: () => id,
              setSharing() {},
              setTrashed: (trashed) => files.set(id, { ...files.get(id), trashed }),
            };
            files.set(id, { blob, trashed: false, file });
            return file;
          },
        };
        folders.set("folder-id", folder);
        return folder;
      },
      getFolderById: (id) => {
        const folder = folders.get(id);
        if (!folder) throw new Error("Missing mock folder");
        return folder;
      },
      getFileById: (id) => {
        const file = files.get(id)?.file;
        if (!file) throw new Error("Missing mock file");
        return file;
      },
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }),
    },
    testProperties: properties,
  };
  vm.createContext(context);
  const source = await readFile(new URL("../Code.gs", import.meta.url), "utf8");
  vm.runInContext(source, context);
  return context;
}

test("Apps Script API supports posts, nested comments, photos, and admin controls", async () => {
  const app = await createAppsScriptContext();
  assert.equal(
    app.derivePassword_("test-password", "stable-salt", 2),
    pbkdf2Sync("test-password", "stable-salt", 2, 32, "sha256").toString("base64url"),
  );
  const setup = app.setupLostAndFound();
  assert.equal(setup.initialized, true);
  const setupToken = app.testProperties.get("ADMIN_SETUP_TOKEN");
  assert.ok(setupToken);
  assert.equal(app.apiRequest("GET", "/api/admin/setup-status", null, "").data.setupRequired, true);

  app.testProperties.set("VERCEL_PROXY_SECRET", "test-proxy-secret");
  const unauthorizedProxy = app.doPost({
    postData: { contents: JSON.stringify({ method: "GET", requestPath: "/api/health" }) },
  });
  assert.equal(JSON.parse(unauthorizedProxy.content).status, 403);
  const proxiedHealth = app.doPost({
    postData: {
      contents: JSON.stringify({
        method: "GET",
        requestPath: "/api/health",
        proxySecret: "test-proxy-secret",
      }),
    },
  });
  assert.deepEqual(JSON.parse(proxiedHealth.content), {
    status: 200,
    data: { status: "ok" },
  });

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const created = app.apiRequest("POST", "/api/items", {
    board: "lost",
    category: "전자기기",
    title: "무선 이어폰",
    description: "검정색 케이스",
    nickname: "테스트",
    password: "item-pass-123",
    status: "searching",
    photos: [{ name: "lost.png", type: "image/png", data: png }],
  }, "");
  assert.equal(created.status, 201);
  assert.equal(created.data.images.length, 1);

  const badCategory = app.apiRequest("POST", "/api/items", {
    board: "lost", category: "unknown", title: "x", description: "x", password: "item-pass-123",
  }, "");
  assert.equal(badCategory.status, 400);

  const comment = app.apiRequest("POST", `/api/items/${created.data.id}/comments`, {
    nickname: "댓글", content: "첫 댓글", password: "comment-pass-123",
  }, "");
  assert.equal(comment.status, 201);
  const reply = app.apiRequest("POST", `/api/items/${created.data.id}/comments`, {
    nickname: "답글", content: "대댓글", password: "reply-pass-123", parentId: comment.data.id,
  }, "");
  assert.equal(reply.status, 201);

  const details = app.apiRequest("GET", `/api/items/${created.data.id}`, null, "");
  assert.equal(details.data.comments.length, 2);
  assert.equal(details.data.comments[1].parentId, comment.data.id);
  assert.equal(details.data.images.length, 1);

  const setupAdmin = app.apiRequest("POST", "/api/admin/setup", {
    username: "test-admin",
    password: "initial-admin-pass",
    setupToken,
  }, "");
  assert.equal(setupAdmin.status, 200);
  const token = setupAdmin.data.sessionToken;
  assert.equal(app.apiRequest("GET", "/api/admin/me", null, token).data.needsPasswordChange, true);
  assert.equal(app.apiRequest("GET", "/api/admin/items", null, token).status, 428);

  assert.equal(app.apiRequest("POST", "/api/admin/change-password", {
    currentPassword: "initial-admin-pass",
    newPassword: "new-admin-password-long-enough",
  }, token).status, 200);
  assert.equal(app.apiRequest("GET", "/api/admin/items", null, token).data.length, 1);

  assert.equal(app.apiRequest("DELETE", `/api/comments/${comment.data.id}`, {
    password: "wrong-password",
  }, "").status, 403);
  assert.equal(app.apiRequest("DELETE", `/api/comments/${comment.data.id}`, {
    password: "comment-pass-123",
  }, "").status, 204);
  assert.equal(app.apiRequest("GET", `/api/items/${created.data.id}`, null, "").data.comments.length, 0);

  assert.equal(app.apiRequest("POST", "/api/admin/logout", null, token).status, 204);
  assert.equal(app.apiRequest("GET", "/api/admin/me", null, token).data.authenticated, false);
  assert.equal(app.testProperties.has("ADMIN_SETUP_TOKEN"), false);
  assert.equal(app.setupLostAndFound().setupToken, undefined);
  assert.equal(app.testProperties.has("ADMIN_SETUP_TOKEN"), false);
});
