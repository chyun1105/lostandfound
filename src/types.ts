export type BoardType = "found" | "lost";
export type ItemStatus = "stored" | "delivered" | "searching" | "found";
export const itemCategories = [
  "지갑",
  "가방",
  "카드",
  "전자기기",
  "의류",
  "도서/문구류",
  "기타",
] as const;
export type ItemCategory = (typeof itemCategories)[number];

export interface Comment {
  id: string;
  parentId: string | null;
  nickname: string;
  content: string;
  createdAt: string;
  images: string[];
}

export interface LostFoundItem {
  id: string;
  board: BoardType;
  category: ItemCategory;
  title: string;
  description: string;
  foundLocation?: string;
  storageLocation?: string;
  nickname: string;
  status: ItemStatus;
  createdAt: string;
  images: string[];
  comments: Comment[];
  lastBumpedAt?: string;
}

export type SortOrder = "newest" | "oldest";
