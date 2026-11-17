import type { BoardType, ItemStatus, LostFoundItem, SortOrder } from "./types";

type ApiPayload = Record<string, unknown> & {
  photos?: { name: string; type: string; data: string }[];
};

const adminSessionKey = "lostnfound.admin-session";
const maxPhotoBytes = 3 * 1024 * 1024;
let inMemoryAdminSession = "";

function getAdminSessionToken() {
  try {
    return sessionStorage.getItem(adminSessionKey) ?? inMemoryAdminSession;
  } catch {
    return inMemoryAdminSession;
  }
}

function setAdminSessionToken(token: string | null) {
  inMemoryAdminSession = token ?? "";
  try {
    if (token) sessionStorage.setItem(adminSessionKey, token);
    else sessionStorage.removeItem(adminSessionKey);
  } catch {
    return;
  }
}

async function filePayload(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return { name: file.name, type: file.type, data: btoa(binary) };
}

async function formPayload(form: FormData): Promise<ApiPayload> {
  const payload: ApiPayload = {};
  const photos: File[] = [];
  form.forEach((value, key) => {
    if (value instanceof File) {
      if (value.size > 0) photos.push(value);
    } else {
      payload[key] = value;
    }
  });
  if (photos.length > 3) throw new Error("사진은 최대 3장까지 등록할 수 있습니다.");
  if (photos.reduce((total, file) => total + file.size, 0) > maxPhotoBytes) {
    throw new Error("Vercel 업로드 한도에 맞춰 사진을 한 번에 총 3MB 이하로 등록해 주세요.");
  }
  if (photos.length > 0) payload.photos = await Promise.all(photos.map(filePayload));
  return payload;
}

function updateAdminSession(url: string, method: string, data: unknown) {
  if (method === "POST" && url === "/api/admin/logout") {
    setAdminSessionToken(null);
  }
  if ((url === "/api/admin/login" || url === "/api/admin/setup") && data) {
    const token = (data as { sessionToken?: string }).sessionToken;
    if (token) setAdminSessionToken(token);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? "GET";
  let body: BodyInit | undefined;
  if (init?.body instanceof FormData) {
    body = JSON.stringify(await formPayload(init.body));
  } else {
    body = init?.body ?? undefined;
  }
  const sessionToken = getAdminSessionToken();
  const response = await fetch(url, {
    ...init,
    method,
    body,
    credentials: "same-origin",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(sessionToken ? { "X-Admin-Session": sessionToken } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) {
    updateAdminSession(url, method, null);
    return undefined as T;
  }
  const responseText = await response.text();
  let data: unknown;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    const contentType = response.headers.get("Content-Type") ?? "";
    const isHtml = /text\/html/i.test(contentType) || /^\s*<!doctype html|^\s*<html/i.test(responseText);
    throw new Error(isHtml
      ? "API가 HTML 페이지를 반환했습니다. 로컬 개발 중이라면 VITE_API_PROXY_TARGET을 Vercel 주소로 설정하고 다시 실행해 주세요."
      : "서버 응답이 올바른 JSON 형식이 아닙니다.");
  }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data &&
      typeof data.error === "string" ? data.error : `요청에 실패했습니다 (${response.status}).`;
    throw new Error(message);
  }
  updateAdminSession(url, method, data);
  return data as T;
}

export function getItems(options: {
  board: BoardType;
  query: string;
  status: string;
  sort: SortOrder;
}) {
  const params = new URLSearchParams({
    board: options.board,
    q: options.query,
    status: options.status,
    sort: options.sort,
  });
  return request<LostFoundItem[]>(`/api/items?${params}`);
}

export function createItem(data: FormData) {
  return request<LostFoundItem>("/api/items", { method: "POST", body: data });
}

export function addComment(itemId: string, data: {
  nickname: string;
  content: string;
  password: string;
  parentId: string | null;
  images: File[];
}) {
  const formData = new FormData();
  formData.set("nickname", data.nickname);
  formData.set("content", data.content);
  formData.set("password", data.password);
  if (data.parentId) formData.set("parentId", data.parentId);
  data.images.forEach((image) => formData.append("photos", image));
  return request<LostFoundItem["comments"][number]>(`/api/items/${itemId}/comments`, {
    method: "POST",
    body: formData,
  });
}

export function modifyItem(itemId: string, data: Record<string, unknown>) {
  return request<LostFoundItem>(`/api/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteItem(itemId: string, password?: string) {
  return request<void>(`/api/items/${itemId}`, {
    method: "DELETE",
    body: JSON.stringify(password === undefined ? {} : { password }),
  });
}

export function deleteComment(commentId: string, password: string) {
  return request<void>(`/api/comments/${commentId}`, {
    method: "DELETE",
    body: JSON.stringify({ password }),
  });
}

export function adminRequest<T>(url: string, init?: RequestInit) {
  return request<T>(url, init);
}

export type AdminLoginResponse = { username: string };
export type AdminMeResponse = {
  authenticated: boolean;
  username?: string;
  needsPasswordChange?: boolean;
};
export type { ItemStatus };
