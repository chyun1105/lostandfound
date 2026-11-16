const APP_SHEETS = {
  items: ["Items", ["id", "board", "title", "description", "category", "foundLocation", "storageLocation", "nickname", "passwordHash", "status", "createdAt", "bumpedAt", "images"]],
  comments: ["Comments", ["id", "itemId", "parentId", "nickname", "content", "passwordHash", "createdAt", "images"]],
  admin: ["Admin", ["username", "passwordHash", "passwordChangedAt"]],
  bannedWords: ["BannedWords", ["word", "createdAt"]],
};
const APP_CATEGORIES = ["지갑", "가방", "카드", "전자기기", "의류", "도서/문구류", "기타"];
const APP_PROFANITY = [];
const APP_PASSWORD_ITERATIONS = 120000;
const APP_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const APP_MAX_PHOTO_TOTAL_BYTES = 3 * 1024 * 1024;

function doGet() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty("SPREADSHEET_ID") || !properties.getProperty("UPLOADS_FOLDER_ID")) {
    return ContentService.createTextOutput("Run setupLostAndFound() in the Apps Script editor first.")
      .setMimeType(ContentService.MimeType.TEXT);
  }
  return ContentService.createTextOutput("Lost and Found API is ready.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(event) {
  const properties = PropertiesService.getScriptProperties();
  const expectedSecret = properties.getProperty("VERCEL_PROXY_SECRET") || "";
  let request;
  try {
    request = JSON.parse(event && event.postData && event.postData.contents || "{}");
  } catch (error) {
    return jsonOutput_({ status: 400, data: { error: "요청 본문이 올바른 JSON이 아닙니다." } });
  }
  if (!expectedSecret || typeof request.proxySecret !== "string" ||
      !constantTimeEqual_(expectedSecret, request.proxySecret)) {
    return jsonOutput_({ status: 403, data: { error: "프록시 인증에 실패했습니다." } });
  }
  return jsonOutput_(apiRequest(
    request.method,
    request.requestPath,
    request.body,
    request.sessionToken,
  ));
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function setupLostAndFound() {
  const properties = PropertiesService.getScriptProperties();
  let spreadsheetId = properties.getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    const spreadsheet = SpreadsheetApp.create("광주과학고 분실물 보관함 데이터");
    spreadsheetId = spreadsheet.getId();
    properties.setProperty("SPREADSHEET_ID", spreadsheetId);
    const firstSheet = spreadsheet.getSheets()[0];
    firstSheet.setName(APP_SHEETS.items[0]);
    firstSheet.appendRow(APP_SHEETS.items[1]);
  }
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  Object.keys(APP_SHEETS).forEach(function (key) {
    const definition = APP_SHEETS[key];
    let sheet = spreadsheet.getSheetByName(definition[0]);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(definition[0]);
      sheet.appendRow(definition[1]);
    } else if (sheet.getLastRow() === 0) {
      sheet.appendRow(definition[1]);
    }
  });
  let folderId = properties.getProperty("UPLOADS_FOLDER_ID");
  if (!folderId) {
    folderId = DriveApp.createFolder("광주과학고 분실물 보관함 사진").getId();
    properties.setProperty("UPLOADS_FOLDER_ID", folderId);
  }
  let setupToken = properties.getProperty("ADMIN_SETUP_TOKEN");
  const adminSheet = spreadsheet.getSheetByName(APP_SHEETS.admin[0]);
  if (!setupToken && readRows_(adminSheet).length === 0) {
    setupToken = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    properties.setProperty("ADMIN_SETUP_TOKEN", setupToken);
  }
  Logger.log("데이터 스프레드시트: " + spreadsheet.getUrl());
  Logger.log("업로드 폴더: https://drive.google.com/drive/folders/" + folderId);
  if (setupToken) Logger.log("관리자 최초 설정 토큰: " + setupToken);
  return { initialized: true };
}

function apiRequest(method, requestPath, body, sessionToken) {
  try {
    if (typeof method !== "string" || typeof requestPath !== "string" || requestPath.length > 500) {
      return apiResult_(400, { error: "요청 정보가 올바르지 않습니다." });
    }
    const pathParts = requestPath.split("?");
    const path = pathParts[0];
    const query = parseQuery_(pathParts[1] || "");
    const payload = body && typeof body === "object" ? body : {};
    if (JSON.stringify(payload).length > 9 * 1024 * 1024) {
      return apiResult_(413, { error: "요청 크기가 너무 큽니다. 사진은 한 번에 총 3MB 이하로 등록해 주세요." });
    }
    const verb = method.toUpperCase();
    if (path === "/api/health" && verb === "GET") return apiResult_(200, { status: "ok" });

    const properties = PropertiesService.getScriptProperties();
    if (!properties.getProperty("SPREADSHEET_ID") || !properties.getProperty("UPLOADS_FOLDER_ID")) {
      return apiResult_(503, { error: "관리자가 Apps Script 편집기에서 setupLostAndFound를 먼저 실행해야 합니다." });
    }
    const context = getContext_();

    if (path === "/api/items" && verb === "GET") {
      const board = query.board;
      if (board !== "found" && board !== "lost") return apiResult_(400, { error: "게시판 종류가 올바르지 않습니다." });
      const allowedStatuses = board === "found" ? ["stored", "delivered"] : ["searching", "found"];
      const status = query.status || "all";
      if (status !== "all" && allowedStatuses.indexOf(status) < 0) {
        return apiResult_(400, { error: "진행 상태가 올바르지 않습니다." });
      }
      const search = normalize_(text_(query.q, 100));
      const items = context.items.filter(function (item) {
        return item.board === board &&
          (status === "all" || item.status === status) &&
          (!search || normalize_(item.title + " " + item.description).indexOf(search) >= 0);
      });
      items.sort(function (a, b) {
        const aDate = a.bumpedAt || a.createdAt;
        const bDate = b.bumpedAt || b.createdAt;
        return query.sort === "oldest" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
      });
      return apiResult_(200, items.map(function (item) { return publicItem_(item, context.comments); }));
    }

    if (path === "/api/items" && verb === "POST") {
      return withLock_(function () {
        const photos = validatePhotos_(payload.photos, true);
        if (photos.error) return apiResult_(400, { error: photos.error });
        const board = payload.board;
        if (board !== "found" && board !== "lost") return apiResult_(400, { error: "게시판 종류가 올바르지 않습니다." });
        const title = text_(payload.title, 60);
        const description = text_(payload.description, 600);
        const category = payload.category;
        const foundLocation = text_(payload.foundLocation, 80);
        const storageLocation = text_(payload.storageLocation, 80) || foundLocation;
        const nickname = text_(payload.nickname, 20) || "익명";
        const password = typeof payload.password === "string" ? payload.password : "";
        const status = payload.status || (board === "found" ? "stored" : "searching");
        if (!title || !description || APP_CATEGORIES.indexOf(category) < 0 ||
          password.length < 4 || password.length > 128 ||
          (board === "found" && !foundLocation) || !validStatus_(board, status)) {
          return apiResult_(400, { error: "필수 항목을 확인해 주세요. 비밀번호는 4~128자입니다." });
        }
        if (containsBannedWord_(context.bannedWords, title + " " + description + " " + foundLocation + " " + storageLocation + " " + nickname)) {
          return apiResult_(400, { error: "게시글에 사용할 수 없는 표현이 포함되어 있습니다." });
        }
        const passwordHash = hashPassword_(password);
        const images = savePhotos_(photos.files);
        const item = {
          id: Utilities.getUuid().replace(/-/g, ""),
          board: board,
          title: title,
          description: description,
          category: category,
          foundLocation: board === "found" ? foundLocation : "",
          storageLocation: board === "found" ? storageLocation : "",
          nickname: nickname,
          passwordHash: passwordHash,
          status: status,
          createdAt: new Date().toISOString(),
          bumpedAt: "",
          images: JSON.stringify(images),
        };
        try {
          appendObject_(context.sheets.items, item);
        } catch (error) {
          trashImages_(images);
          throw error;
        }
        return apiResult_(201, publicItem_(item, readRows_(context.sheets.comments)));
      });
    }

    const itemMatch = path.match(/^\/api\/items\/([^/]+)$/);
    if (itemMatch && verb === "GET") {
      const item = findById_(context.items, decodeURIComponent(itemMatch[1]));
      return item ? apiResult_(200, publicItem_(item, context.comments)) : apiResult_(404, { error: "게시글을 찾을 수 없습니다." });
    }

    const commentsMatch = path.match(/^\/api\/items\/([^/]+)\/comments$/);
    if (commentsMatch && verb === "POST") {
      return withLock_(function () {
        const item = findById_(readRows_(context.sheets.items), decodeURIComponent(commentsMatch[1]));
        if (!item) return apiResult_(404, { error: "게시글을 찾을 수 없습니다." });
        const photos = validatePhotos_(payload.photos, item.board === "lost");
        if (photos.error) return apiResult_(400, { error: photos.error });
        const nickname = text_(payload.nickname, 20) || "익명";
        const content = text_(payload.content, 300);
        const password = typeof payload.password === "string" ? payload.password : "";
        const parentId = text_(payload.parentId, 32) || "";
        if (!content || password.length < 4 || password.length > 128) {
          return apiResult_(400, { error: "댓글과 4~128자 비밀번호를 입력해 주세요." });
        }
        const comments = readRows_(context.sheets.comments);
        if (parentId && !comments.some(function (comment) { return comment.id === parentId && comment.itemId === item.id; })) {
          return apiResult_(400, { error: "답글을 작성할 댓글을 찾을 수 없습니다." });
        }
        if (containsBannedWord_(context.bannedWords, content + " " + nickname)) {
          return apiResult_(400, { error: "댓글에 사용할 수 없는 표현이 포함되어 있습니다." });
        }
        const images = savePhotos_(photos.files);
        const createdAt = new Date().toISOString();
        const id = Utilities.getUuid().replace(/-/g, "");
        try {
          appendObject_(context.sheets.comments, {
            id: id,
            itemId: item.id,
            parentId: parentId,
            nickname: nickname,
            content: content,
            passwordHash: hashPassword_(password),
            createdAt: createdAt,
            images: JSON.stringify(images),
          });
        } catch (error) {
          trashImages_(images);
          throw error;
        }
        return apiResult_(201, { id: id, parentId: parentId || null, nickname: nickname, content: content, createdAt: createdAt, images: images });
      });
    }

    if (itemMatch && verb === "PATCH") {
      return withLock_(function () {
        const items = readRows_(context.sheets.items);
        const item = findById_(items, decodeURIComponent(itemMatch[1]));
        if (!item) return apiResult_(404, { error: "게시글을 찾을 수 없습니다." });
        if (!verifyPassword_(payload.password, item.passwordHash)) return apiResult_(403, { error: "게시글 비밀번호가 올바르지 않습니다." });
        if (payload.action === "bump") {
          const now = Date.now();
          const bumped = item.bumpedAt ? new Date(item.bumpedAt).getTime() : 0;
          if (bumped && now - bumped < 86400000) {
            const remaining = Math.ceil((86400000 - (now - bumped)) / 3600000);
            return apiResult_(429, { error: "끌어올리기는 24시간에 한 번만 가능합니다. 약 " + remaining + "시간 후 다시 시도해 주세요." });
          }
          item.bumpedAt = new Date(now).toISOString();
        } else if (payload.action === "status") {
          if (!validStatus_(item.board, payload.status)) return apiResult_(400, { error: "진행 상태가 올바르지 않습니다." });
          item.status = payload.status;
        } else if (payload.action === "edit") {
          const title = text_(payload.title, 60);
          const description = text_(payload.description, 600);
          const category = payload.category;
          const foundLocation = text_(payload.foundLocation, 80);
          const storageLocation = text_(payload.storageLocation, 80) || foundLocation;
          const nickname = text_(payload.nickname, 20) || "익명";
          if (!title || !description || APP_CATEGORIES.indexOf(category) < 0 || (item.board === "found" && !foundLocation)) {
            return apiResult_(400, { error: "필수 항목을 입력해 주세요." });
          }
          if (containsBannedWord_(context.bannedWords, title + " " + description + " " + foundLocation + " " + storageLocation + " " + nickname)) {
            return apiResult_(400, { error: "게시글에 사용할 수 없는 표현이 포함되어 있습니다." });
          }
          item.title = title;
          item.description = description;
          item.category = category;
          item.foundLocation = item.board === "found" ? foundLocation : "";
          item.storageLocation = item.board === "found" ? storageLocation : "";
          item.nickname = nickname;
        } else {
          return apiResult_(400, { error: "요청한 작업이 올바르지 않습니다." });
        }
        updateObject_(context.sheets.items, item.id, item);
        return apiResult_(200, publicItem_(item, readRows_(context.sheets.comments)));
      });
    }

    if (itemMatch && verb === "DELETE") {
      return withLock_(function () {
        const itemId = decodeURIComponent(itemMatch[1]);
        const item = findById_(readRows_(context.sheets.items), itemId);
        if (!item) return apiResult_(404, { error: "게시글을 찾을 수 없습니다." });
        if (!verifyPassword_(payload.password, item.passwordHash)) return apiResult_(403, { error: "게시글 비밀번호가 올바르지 않습니다." });
        const comments = readRows_(context.sheets.comments).filter(function (comment) { return comment.itemId === itemId; });
        const images = JSON.parse(item.images).concat(comments.reduce(function (all, comment) {
          return all.concat(JSON.parse(comment.images));
        }, []));
        trashImages_(images);
        deleteRowsByIds_(context.sheets.comments, comments.map(function (comment) { return comment.id; }));
        deleteRowsByIds_(context.sheets.items, [itemId]);
        return apiResult_(204, null);
      });
    }

    const commentMatch = path.match(/^\/api\/comments\/([^/]+)$/);
    if (commentMatch && verb === "DELETE") {
      return withLock_(function () {
        const comments = readRows_(context.sheets.comments);
        const target = findById_(comments, decodeURIComponent(commentMatch[1]));
        if (!target) return apiResult_(404, { error: "댓글을 찾을 수 없습니다." });
        if (!verifyPassword_(payload.password, target.passwordHash)) return apiResult_(403, { error: "댓글 비밀번호가 올바르지 않습니다." });
        const removed = descendantComments_(comments, target.id);
        trashImages_(removed.reduce(function (all, comment) {
          return all.concat(JSON.parse(comment.images));
        }, []));
        deleteRowsByIds_(context.sheets.comments, removed.map(function (comment) { return comment.id; }));
        return apiResult_(204, null);
      });
    }

    if (path === "/api/admin/setup-status" && verb === "GET") {
      return apiResult_(200, { setupRequired: !context.admin });
    }

    if (path === "/api/admin/setup" && verb === "POST") {
      return withLock_(function () {
        const latest = getContext_();
        if (latest.admin) return apiResult_(409, { error: "관리자 계정이 이미 설정되어 있습니다." });
        const properties = PropertiesService.getScriptProperties();
        if (!payload.setupToken || payload.setupToken !== properties.getProperty("ADMIN_SETUP_TOKEN")) {
          return apiResult_(403, { error: "관리자 설정 토큰이 올바르지 않습니다." });
        }
        const username = text_(payload.username, 40);
        const password = typeof payload.password === "string" ? payload.password : "";
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 12 || password.length > 128) {
          return apiResult_(400, { error: "아이디는 영문·숫자·._- 조합 3~40자, 비밀번호는 12~128자로 설정해 주세요." });
        }
        appendObject_(latest.sheets.admin, {
          username: username,
          passwordHash: hashPassword_(password),
          passwordChangedAt: "",
        });
        properties.deleteProperty("ADMIN_SETUP_TOKEN");
        const token = createSession_(username);
        return apiResult_(200, { username: username, sessionToken: token });
      });
    }

    if (path === "/api/admin/login" && verb === "POST") {
      const username = text_(payload.username, 40);
      const admin = context.admin;
      if (!admin || admin.username !== username || !verifyPassword_(payload.password, admin.passwordHash)) {
        return apiResult_(401, { error: "아이디 또는 비밀번호를 확인해 주세요." });
      }
      return apiResult_(200, { username: admin.username, sessionToken: createSession_(admin.username) });
    }

    if (path === "/api/admin/logout" && verb === "POST") {
      deleteSession_(sessionToken);
      return apiResult_(204, null);
    }

    if (path === "/api/admin/me" && verb === "GET") {
      const admin = authenticatedAdmin_(sessionToken);
      return admin
        ? apiResult_(200, { authenticated: true, username: admin.username, needsPasswordChange: !admin.passwordChangedAt })
        : apiResult_(200, { authenticated: false });
    }

    if (path === "/api/admin/change-password" && verb === "POST") {
      return withLock_(function () {
        const admin = authenticatedAdmin_(sessionToken);
        if (!admin) return apiResult_(401, { error: "관리자 로그인이 필요합니다." });
        if (!verifyPassword_(payload.currentPassword, admin.passwordHash)) return apiResult_(403, { error: "현재 비밀번호가 올바르지 않습니다." });
        const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
        if (newPassword.length < 16 || newPassword.length > 128) return apiResult_(400, { error: "새 비밀번호는 16~128자로 설정해 주세요." });
        admin.passwordHash = hashPassword_(newPassword);
        admin.passwordChangedAt = new Date().toISOString();
        updateObject_(context.sheets.admin, admin.username, admin, "username");
        return apiResult_(200, { changed: true });
      });
    }

    const adminItemMatch = path.match(/^\/api\/admin\/items(?:\/([^/]+))?$/);
    if (path === "/api/admin/items" && verb === "GET") {
      const admin = requireAdmin_(sessionToken);
      if (admin.error) return apiResult_(admin.status, { error: admin.error });
      return apiResult_(200, context.items.map(function (item) { return publicItem_(item, context.comments); }));
    }
    if (adminItemMatch && adminItemMatch[1] && verb === "PATCH") {
      return withLock_(function () {
        const admin = requireAdmin_(sessionToken);
        if (admin.error) return apiResult_(admin.status, { error: admin.error });
        const item = findById_(readRows_(context.sheets.items), decodeURIComponent(adminItemMatch[1]));
        if (!item) return apiResult_(404, { error: "게시글을 찾을 수 없습니다." });
        if (!validStatus_(item.board, payload.status)) return apiResult_(400, { error: "진행 상태가 올바르지 않습니다." });
        item.status = payload.status;
        updateObject_(context.sheets.items, item.id, item);
        return apiResult_(200, publicItem_(item, readRows_(context.sheets.comments)));
      });
    }
    if (adminItemMatch && adminItemMatch[1] && verb === "DELETE") {
      return withLock_(function () {
        const admin = requireAdmin_(sessionToken);
        if (admin.error) return apiResult_(admin.status, { error: admin.error });
        const itemId = decodeURIComponent(adminItemMatch[1]);
        const item = findById_(readRows_(context.sheets.items), itemId);
        if (!item) return apiResult_(404, { error: "게시글을 찾을 수 없습니다." });
        const comments = readRows_(context.sheets.comments).filter(function (comment) { return comment.itemId === itemId; });
        trashImages_(JSON.parse(item.images).concat(comments.reduce(function (all, comment) {
          return all.concat(JSON.parse(comment.images));
        }, [])));
        deleteRowsByIds_(context.sheets.comments, comments.map(function (comment) { return comment.id; }));
        deleteRowsByIds_(context.sheets.items, [itemId]);
        return apiResult_(204, null);
      });
    }

    if (path === "/api/admin/banned-words" && verb === "GET") {
      const admin = requireAdmin_(sessionToken);
      if (admin.error) return apiResult_(admin.status, { error: admin.error });
      return apiResult_(200, context.bannedWords);
    }
    if (path === "/api/admin/banned-words" && verb === "POST") {
      return withLock_(function () {
        const admin = requireAdmin_(sessionToken);
        if (admin.error) return apiResult_(admin.status, { error: admin.error });
        const word = text_(payload.word, 40);
        if (normalize_(word).length < 2) return apiResult_(400, { error: "금지어는 2자 이상 입력해 주세요." });
        const words = readRows_(context.sheets.bannedWords);
        if (!words.some(function (entry) { return entry.word === word; })) {
          appendObject_(context.sheets.bannedWords, { word: word, createdAt: new Date().toISOString() });
        }
        return apiResult_(201, { word: word });
      });
    }
    const bannedWordMatch = path.match(/^\/api\/admin\/banned-words\/(.+)$/);
    if (bannedWordMatch && verb === "DELETE") {
      return withLock_(function () {
        const admin = requireAdmin_(sessionToken);
        if (admin.error) return apiResult_(admin.status, { error: admin.error });
        deleteRowsByIds_(context.sheets.bannedWords, [decodeURIComponent(bannedWordMatch[1])], "word");
        return apiResult_(204, null);
      });
    }

    return apiResult_(404, { error: "요청한 주소를 찾을 수 없습니다." });
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return apiResult_(500, { error: "서버 오류가 발생했습니다. Apps Script 실행 기록을 확인해 주세요." });
  }
}

function getContext_() {
  const id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) throw new Error("setupLostAndFound를 먼저 실행해야 합니다.");
  const spreadsheet = SpreadsheetApp.openById(id);
  const sheets = {};
  Object.keys(APP_SHEETS).forEach(function (key) {
    sheets[key] = spreadsheet.getSheetByName(APP_SHEETS[key][0]);
    if (!sheets[key]) throw new Error("필수 시트를 찾을 수 없습니다: " + APP_SHEETS[key][0]);
  });
  const items = readRows_(sheets.items);
  const comments = readRows_(sheets.comments);
  const admins = readRows_(sheets.admin);
  return {
    sheets: sheets,
    items: items,
    comments: comments,
    admin: admins.length ? admins[0] : null,
    bannedWords: readRows_(sheets.bannedWords),
  };
}

function readRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(function (row) { return row.some(function (value) { return value !== ""; }); })
    .map(function (row) {
      const object = {};
      headers.forEach(function (header, index) { object[header] = row[index] === null ? "" : row[index]; });
      return object;
    });
}

function appendObject_(sheet, object) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.appendRow(headers.map(function (header) {
    const value = object[header];
    return value === undefined || value === null ? "" : value;
  }));
}

function updateObject_(sheet, key, object, keyColumn) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const keyName = keyColumn || "id";
  const keyIndex = headers.indexOf(keyName);
  if (keyIndex < 0) throw new Error("시트 키 열을 찾을 수 없습니다: " + keyName);
  const values = sheet.getDataRange().getValues();
  for (let index = 1; index < values.length; index += 1) {
    if (String(values[index][keyIndex]) === String(key)) {
      sheet.getRange(index + 1, 1, 1, headers.length).setValues([headers.map(function (header) {
        const value = object[header];
        return value === undefined || value === null ? "" : value;
      })]);
      return;
    }
  }
  throw new Error("수정할 시트 데이터를 찾을 수 없습니다: " + key);
}

function deleteRowsByIds_(sheet, ids, keyColumn) {
  if (!ids.length) return;
  const keyName = keyColumn || "id";
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const keyIndex = headers.indexOf(keyName);
  if (keyIndex < 0) throw new Error("시트 키 열을 찾을 수 없습니다: " + keyName);
  const targets = {};
  ids.forEach(function (id) { targets[String(id)] = true; });
  const deleteRows = [];
  for (let index = 1; index < values.length; index += 1) {
    if (targets[String(values[index][keyIndex])]) deleteRows.push(index + 1);
  }
  deleteRows.reverse().forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
}

function publicItem_(item, comments) {
  return {
    id: String(item.id),
    board: item.board,
    title: item.title,
    description: item.description,
    category: item.category,
    ...(item.foundLocation ? { foundLocation: item.foundLocation } : {}),
    ...(item.storageLocation ? { storageLocation: item.storageLocation } : {}),
    nickname: item.nickname,
    status: item.status,
    createdAt: item.createdAt,
    ...(item.bumpedAt ? { lastBumpedAt: item.bumpedAt } : {}),
    images: parseJsonArray_(item.images),
    comments: comments.filter(function (comment) { return comment.itemId === item.id; })
      .sort(function (a, b) { return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); })
      .map(function (comment) {
        return {
          id: String(comment.id),
          parentId: comment.parentId || null,
          nickname: comment.nickname,
          content: comment.content,
          createdAt: comment.createdAt,
          images: parseJsonArray_(comment.images),
        };
      }),
  };
}

function parseJsonArray_(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("저장된 이미지 목록이 올바르지 않습니다.", error);
    throw new Error("저장된 사진 정보를 읽지 못했습니다.");
  }
}

function validatePhotos_(photos, allowPhotos) {
  const files = photos === undefined || photos === null ? [] : photos;
  if (!Array.isArray(files) || files.length > 3) return { error: "사진 업로드 한도(최대 3장)를 확인해 주세요." };
  if (!allowPhotos && files.length) return { error: "분실물 게시글 댓글에만 사진을 첨부할 수 있습니다." };
  let total = 0;
  let encodedTotal = 0;
  for (let index = 0; index < files.length; index += 1) {
    const photo = files[index];
    if (!photo || typeof photo.name !== "string" || typeof photo.type !== "string" || typeof photo.data !== "string") {
      return { error: "사진 파일 정보를 확인해 주세요." };
    }
    const extension = photo.name.toLowerCase().split(".").pop();
    const expectedType = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "png" ? "image/png"
        : extension === "webp" ? "image/webp" : "";
    if (!expectedType || photo.type !== expectedType) return { error: "JPG, PNG, WebP 이미지 파일만 등록할 수 있습니다." };
    if (photo.data.length > Math.ceil(APP_MAX_PHOTO_BYTES / 3) * 4) return { error: "사진 한 장은 5MB 이하여야 합니다." };
    encodedTotal += photo.data.length;
    if (encodedTotal > Math.ceil(APP_MAX_PHOTO_TOTAL_BYTES / 3) * 4) {
      return { error: "사진은 한 번에 총 3MB 이하로 등록해 주세요." };
    }
    const bytes = Utilities.base64Decode(photo.data);
    total += bytes.length;
    if (bytes.length === 0 || bytes.length > APP_MAX_PHOTO_BYTES) return { error: "사진 한 장은 5MB 이하여야 합니다." };
    if (!hasImageSignature_(bytes, expectedType)) return { error: "이미지 파일의 실제 형식을 확인할 수 없습니다." };
  }
  if (total > APP_MAX_PHOTO_TOTAL_BYTES) return { error: "사진은 한 번에 총 3MB 이하로 등록해 주세요." };
  return { files: files };
}

function hasImageSignature_(bytes, mimeType) {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && (bytes[0] & 255) === 255 && (bytes[1] & 255) === 216 && (bytes[2] & 255) === 255;
  if (mimeType === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    return bytes.length >= signature.length && signature.every(function (value, index) { return (bytes[index] & 255) === value; });
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 &&
      String.fromCharCode.apply(null, bytes.slice(0, 4).map(function (byte) { return byte & 255; })) === "RIFF" &&
      String.fromCharCode.apply(null, bytes.slice(8, 12).map(function (byte) { return byte & 255; })) === "WEBP";
  }
  return false;
}

function savePhotos_(photos) {
  const folderId = PropertiesService.getScriptProperties().getProperty("UPLOADS_FOLDER_ID");
  if (!folderId) throw new Error("사진 폴더가 설정되지 않았습니다.");
  const folder = DriveApp.getFolderById(folderId);
  const urls = [];
  try {
    photos.forEach(function (photo) {
      const extension = photo.name.toLowerCase().split(".").pop();
      const blob = Utilities.newBlob(Utilities.base64Decode(photo.data), photo.type, Utilities.getUuid() + "." + extension);
      const file = folder.createFile(blob);
      const url = "https://drive.google.com/uc?export=view&id=" + file.getId();
      urls.push(url);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    });
    return urls;
  } catch (error) {
    trashImages_(urls);
    throw error;
  }
}

function trashImages_(urls) {
  urls.forEach(function (url) {
    const match = String(url).match(/[?&]id=([^&]+)/);
    if (!match) return;
    DriveApp.getFileById(decodeURIComponent(match[1])).setTrashed(true);
  });
}

function hashPassword_(password) {
  const salt = Utilities.getUuid() + Utilities.getUuid();
  return "sha256i$" + APP_PASSWORD_ITERATIONS + "$" + salt + "$" + derivePassword_(password, salt, APP_PASSWORD_ITERATIONS);
}

function verifyPassword_(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "sha256i") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 400000) return false;
  return constantTimeEqual_(derivePassword_(password, parts[2], iterations), parts[3]);
}

function derivePassword_(password, salt, iterations) {
  const key = Utilities.newBlob(password).getBytes();
  const block = Utilities.newBlob(salt).getBytes().concat([0, 0, 0, 1]);
  let digest = Utilities.computeHmacSha256Signature(block, key);
  const derived = digest.slice();
  for (let index = 1; index < iterations; index += 1) {
    digest = Utilities.computeHmacSha256Signature(digest, key);
    for (let byte = 0; byte < derived.length; byte += 1) derived[byte] ^= digest[byte];
  }
  return Utilities.base64EncodeWebSafe(derived).replace(/=+$/g, "");
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function createSession_(username) {
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const expiry = Date.now() + 12 * 60 * 60 * 1000;
  PropertiesService.getScriptProperties().setProperty(sessionPropertyKey_(token), JSON.stringify({ username: username, expiry: expiry }));
  return token;
}

function authenticatedAdmin_(token) {
  if (!token || typeof token !== "string" || token.length > 100) return null;
  const properties = PropertiesService.getScriptProperties();
  const value = properties.getProperty(sessionPropertyKey_(token));
  if (!value) return null;
  let session;
  try {
    session = JSON.parse(value);
  } catch (error) {
    properties.deleteProperty(sessionPropertyKey_(token));
    return null;
  }
  if (session.expiry <= Date.now()) {
    properties.deleteProperty(sessionPropertyKey_(token));
    return null;
  }
  const admin = readRows_(getContext_().sheets.admin)[0];
  return admin && admin.username === session.username ? admin : null;
}

function requireAdmin_(token) {
  const admin = authenticatedAdmin_(token);
  if (!admin) return { error: "관리자 로그인이 필요합니다.", status: 401 };
  if (!admin.passwordChangedAt) return { error: "외부 공개 전에 관리자 비밀번호를 16자 이상으로 변경해 주세요.", status: 428 };
  return admin;
}

function deleteSession_(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty(sessionPropertyKey_(token));
}

function sessionPropertyKey_(token) {
  return "SESSION_" + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token),
  ).replace(/=+$/g, "");
}

function containsBannedWord_(words, value) {
  const normalized = normalize_(value);
  if (APP_PROFANITY.some(function (word) { return normalized.indexOf(normalize_(word)) >= 0; })) return true;
  return words.some(function (entry) { return normalized.indexOf(normalize_(entry.word)) >= 0; });
}

function normalize_(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}\p{Z}\u200b\d]/gu, "");
}

function text_(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validStatus_(board, status) {
  return board === "found"
    ? status === "stored" || status === "delivered"
    : status === "searching" || status === "found";
}

function findById_(rows, id) {
  return rows.find(function (row) { return String(row.id || row.word) === String(id); }) || null;
}

function descendantComments_(comments, rootId) {
  const ids = {};
  ids[rootId] = true;
  let changed = true;
  while (changed) {
    changed = false;
    comments.forEach(function (comment) {
      if (comment.parentId && ids[comment.parentId] && !ids[comment.id]) {
        ids[comment.id] = true;
        changed = true;
      }
    });
  }
  return comments.filter(function (comment) { return ids[comment.id]; });
}

function parseQuery_(queryString) {
  const result = {};
  queryString.split("&").forEach(function (part) {
    if (!part) return;
    const pair = part.split("=");
    const key = decodeURIComponent((pair[0] || "").replace(/\+/g, " "));
    const value = decodeURIComponent((pair.slice(1).join("=") || "").replace(/\+/g, " "));
    result[key] = value;
  });
  return result;
}

function apiResult_(status, data) {
  return { status: status, data: data };
}

function withLock_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return apiResult_(503, { error: "요청이 많습니다. 잠시 후 다시 시도해 주세요." });
  try {
    return action();
  } finally {
    lock.releaseLock();
  }
}
