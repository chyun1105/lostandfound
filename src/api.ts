import type { BoardType, ItemStatus, LostFoundItem, SortOrder } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `요청에 실패했습니다 (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
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
