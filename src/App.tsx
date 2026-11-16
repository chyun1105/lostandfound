import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronDown,
  Clock3,
  ImagePlus,
  MapPin,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  addComment as apiAddComment,
  adminRequest,
  createItem,
  deleteComment as apiDeleteComment,
  deleteItem,
  getItems,
  modifyItem,
  type AdminMeResponse,
} from "./api";
import type {
  BoardType,
  ItemCategory,
  ItemStatus,
  LostFoundItem,
  SortOrder,
} from "./types";
import { itemCategories } from "./types";

const statusLabels: Record<ItemStatus, string> = {
  stored: "보관 중",
  delivered: "전달 완료",
  searching: "찾는 중",
  found: "찾음",
};

const statusOptions: Record<BoardType, ItemStatus[]> = {
  found: ["stored", "delivered"],
  lost: ["searching", "found"],
};

function formatDate(date: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
}

function App() {
  const [board, setBoard] = useState<BoardType>("found");
  const [items, setItems] = useState<LostFoundItem[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [selectedItem, setSelectedItem] = useState<LostFoundItem | null>(null);
  const [isWriting, setIsWriting] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    Promise.all(
      (["found", "lost"] as const).map((currentBoard) =>
        getItems({ board: currentBoard, query: "", status: "all", sort: sortOrder }),
      ),
    ).then((boards) => {
      if (active) setItems(boards.flat());
    }).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "게시글을 불러오지 못했습니다.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reloadKey, sortOrder]);

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return items
      .filter((item) => item.board === board)
      .filter((item) => statusFilter === "all" || item.status === statusFilter)
      .filter((item) => categoryFilter === "all" || item.category === categoryFilter)
      .filter(
        (item) =>
          !normalizedQuery ||
          `${item.title} ${item.description}`.toLocaleLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) =>
        sortOrder === "newest"
          ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          : new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
  }, [board, categoryFilter, items, query, sortOrder, statusFilter]);

  function changeBoard(nextBoard: BoardType) {
    setBoard(nextBoard);
    setStatusFilter("all");
    setQuery("");
  }

  async function addItem(data: FormData) {
    try {
      const item = await createItem(data);
      setIsWriting(false);
      setSelectedItem(item);
      setReloadKey((current) => current + 1);
    } catch (error) {
      throw error instanceof Error ? error : new Error("게시글을 등록하지 못했습니다.");
    }
  }

  async function addComment(
    itemId: string,
    nickname: string,
    content: string,
    password: string,
    parentId: string | null,
    images: File[],
  ) {
    const comment = await apiAddComment(itemId, { nickname, content, password, parentId, images });
    setItems((current) => current.map((item) => item.id === itemId
      ? { ...item, comments: [...item.comments, comment] }
      : item));
  }

  async function removeComment(itemId: string, commentId: string, password: string) {
    await apiDeleteComment(commentId, password);
    setItems((current) => current.map((item) => {
      if (item.id !== itemId) return item;
      const removedIds = new Set([commentId]);
      let foundDescendant = true;
      while (foundDescendant) {
        foundDescendant = false;
        for (const entry of item.comments) {
          if (entry.parentId && removedIds.has(entry.parentId) && !removedIds.has(entry.id)) {
            removedIds.add(entry.id);
            foundDescendant = true;
          }
        }
      }
      return { ...item, comments: item.comments.filter((entry) => !removedIds.has(entry.id)) };
    }));
  }

  async function updateItem(item: LostFoundItem) {
    setItems((current) => current.map((entry) => entry.id === item.id ? item : entry));
    setSelectedItem(item);
  }

  async function removeItem(itemId: string, password: string) {
    await deleteItem(itemId, password);
    setSelectedItem(null);
    setItems((current) => current.filter((entry) => entry.id !== itemId));
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="/" aria-label="분실물 보관함 홈">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="brand-copy">
              <strong>분실물 보관함</strong>
              <small>광주과학고등학교</small>
            </span>
          </a>
          <button
            className="school-label"
            type="button"
            onClick={() => setShowAdmin(true)}
            aria-label="관리자 로그인"
          >
            <ShieldCheck size={17} />
            <span>관리자</span>
          </button>
        </div>
      </header>

      <main className="page-content">
        <section className="page-heading" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">광주과학고등학교</p>
            <h1 id="page-title">분실물 보관함</h1>
            <p style={{ fontSize: '12px', color: 'gray' }}><small>베타테스트 버전</small></p>

          </div>
          <button className="text-button guide-button" onClick={() => setShowInfo(true)}>
            이용 안내 <ChevronDown size={16} />
          </button>
        </section>

        <section className="board-panel" aria-label="게시판">
          <div className="board-tabs" role="tablist" aria-label="게시판 종류">
            <button
              className={`board-tab ${board === "found" ? "active" : ""}`}
              onClick={() => changeBoard("found")}
              role="tab"
              aria-selected={board === "found"}
            >
              <span>습득물</span>
              <span className="tab-count">{items.filter((item) => item.board === "found").length}</span>
            </button>
            <button
              className={`board-tab ${board === "lost" ? "active" : ""}`}
              onClick={() => changeBoard("lost")}
              role="tab"
              aria-selected={board === "lost"}
            >
              <span>분실물</span>
              <span className="tab-count">{items.filter((item) => item.board === "lost").length}</span>
            </button>
          </div>

          <div className="toolbar">
            <label className="search-field">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                placeholder="이름이나 특징으로 검색"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="이름이나 특징으로 검색"
              />
              {query && (
                <button
                  type="button"
                  className="clear-search"
                  onClick={() => setQuery("")}
                  aria-label="검색어 지우기"
                >
                  <X size={15} />
                </button>
              )}
            </label>
            <div className="toolbar-actions">
              <label className="select-field">
                <span className="sr-only">진행 상태 필터</span>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                >
                  <option value="all">전체 상태</option>
                  {statusOptions[board].map((status) => (
                    <option key={status} value={status}>
                      {statusLabels[status]}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </label>
              <label className="select-field">
                <span className="sr-only">물건 분류 필터</span>
                <select
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  aria-label="물건 분류 필터"
                >
                  <option value="all">전체 분류</option>
                  {itemCategories.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </label>
              <button
                type="button"
                className="sort-button"
                onClick={() =>
                  setSortOrder((current) => (current === "newest" ? "oldest" : "newest"))
                }
                aria-label={`등록일 ${sortOrder === "newest" ? "최신순" : "오래된순"} 정렬`}
              >
                <ArrowDownUp size={16} />
                <span>{sortOrder === "newest" ? "최신순" : "오래된순"}</span>
              </button>
              <button className="primary-button write-button" onClick={() => setIsWriting(true)}>
                <Plus size={18} />
                <span>{board === "found" ? "습득물 올리기" : "분실물 올리기"}</span>
              </button>
            </div>
          </div>

          <div className="list-summary">
            <p>
              <strong>{board === "found" ? "습득물" : "분실물"}</strong>
              <span>총 {visibleItems.length}건</span>
            </p>
          </div>

          {loadError ? (
            <div className="empty-state" role="alert">
              <strong>서버에 연결할 수 없어요</strong>
              <p>{loadError}</p>
              <button className="secondary-button" onClick={() => setReloadKey((current) => current + 1)}>다시 시도</button>
            </div>
          ) : loading ? (
            <div className="empty-state"><strong>게시글을 불러오는 중…</strong></div>
          ) : visibleItems.length > 0 ? (
            <div className="item-grid">
              {visibleItems.map((item) => (
                <button
                  className="item-card"
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  aria-label={`${item.title}, ${statusLabels[item.status]}, ${formatDate(item.createdAt)}`}
                >
                  <div className="card-image">
                    {item.images[0] ? (
                      <img src={item.images[0]} alt="" />
                    ) : (
                      <div className="empty-image">
                        <ImagePlus size={27} strokeWidth={1.5} />
                        <span>사진 없음</span>
                      </div>
                    )}
                    <StatusBadge status={item.status} />
                  </div>
                  <div className="card-content">
                    <h2>{item.title}</h2>
                    <span className="item-category">{item.category}</span>
                    <p className="card-description">{item.description}</p>
                    <div className="card-meta">
                      <span>
                        <Clock3 size={14} />
                        {formatDate(item.createdAt)}
                      </span>
                      {item.foundLocation && (
                        <span className="card-location">
                          <MapPin size={14} />
                          {item.foundLocation}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Search size={24} />
              </div>
              <strong>게시글이 없어요</strong>
              <p>{query ? "검색어나 필터를 바꿔 다시 찾아보세요." : "첫 게시글을 등록해 주세요."}</p>
              {!query && (
                <button className="secondary-button" onClick={() => setIsWriting(true)}>
                  <Plus size={17} /> 게시글 작성
                </button>
              )}
            </div>
          )}
        </section>
        <footer className="site-footer">
          <div className="footer-brand">
            <span>광주과학고등학교 분실물 보관함</span>
          </div>
          <button className="text-button" onClick={() => setShowInfo(true)}>이용 안내</button>
        </footer>
      </main>

      {selectedItem && (
        <ItemDialog
          item={items.find((item) => item.id === selectedItem.id) ?? selectedItem}
          onClose={() => setSelectedItem(null)}
          onComment={addComment}
          onCommentDelete={removeComment}
          onUpdate={updateItem}
          onDelete={removeItem}
        />
      )}
      {isWriting && (
        <WriteDialog
          board={board}
          onClose={() => setIsWriting(false)}
          onSubmit={addItem}
        />
      )}
      {showAdmin && (
        <AdminDialog
          onClose={() => setShowAdmin(false)}
          onChanged={() => setReloadKey((current) => current + 1)}
        />
      )}
      {showInfo && <InfoDialog onClose={() => setShowInfo(false)} />}
    </div>
  );
}

function StatusBadge({ status }: { status: ItemStatus }) {
  return <span className={`status-badge status-${status}`}>{statusLabels[status]}</span>;
}

function DialogFrame({
  children,
  title,
  onClose,
  wide = false,
}: {
  children: React.ReactNode;
  title: string;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`dialog ${wide ? "dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ItemDialog({
  item,
  onClose,
  onComment,
  onCommentDelete,
  onUpdate,
  onDelete,
}: {
  item: LostFoundItem;
  onClose: () => void;
  onComment: (
    itemId: string,
    nickname: string,
    content: string,
    password: string,
    parentId: string | null,
    images: File[],
  ) => Promise<void>;
  onCommentDelete: (itemId: string, commentId: string, password: string) => Promise<void>;
  onUpdate: (item: LostFoundItem) => void;
  onDelete: (itemId: string, password: string) => Promise<void>;
}) {
  const [nickname, setNickname] = useState("");
  const [comment, setComment] = useState("");
  const [commentPassword, setCommentPassword] = useState("");
  const [commentImages, setCommentImages] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [nextStatus, setNextStatus] = useState<ItemStatus>(item.status);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [category, setCategory] = useState<ItemCategory>(item.category);
  const [foundLocation, setFoundLocation] = useState(item.foundLocation ?? "");
  const [storageLocation, setStorageLocation] = useState(item.storageLocation ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const commentFileInput = useRef<HTMLInputElement>(null);

  const commentsByParent = useMemo(() => {
    const grouped = new Map<string | null, typeof item.comments>();
    for (const entry of item.comments) {
      const siblings = grouped.get(entry.parentId) ?? [];
      siblings.push(entry);
      grouped.set(entry.parentId, siblings);
    }
    return grouped;
  }, [item.comments]);

  async function submitComment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await onComment(item.id, nickname, comment, commentPassword, replyTo, commentImages);
      setComment("");
      setCommentPassword("");
      setCommentImages([]);
      setReplyTo(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "댓글을 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function update(action: "status" | "bump" | "edit") {
    setError("");
    setBusy(true);
    try {
      const updated = await modifyItem(item.id, {
        password,
        action,
        ...(action === "status" ? { status: nextStatus } : {}),
        ...(action === "edit" ? {
          title,
          description,
          category,
          foundLocation,
          storageLocation,
          nickname: item.nickname,
        } : {}),
      });
      onUpdate(updated);
      setEditing(false);
      if (action === "bump") setError("게시글을 끌어올렸습니다.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function deletePost() {
    if (!window.confirm("게시글을 삭제할까요?")) return;
    setError("");
    setBusy(true);
    try {
      await onDelete(item.id, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "게시글을 삭제하지 못했습니다.");
      setBusy(false);
    }
  }

  return (
    <DialogFrame title="게시글 상세" onClose={onClose} wide>
      <div className="detail-layout">
        <div className="detail-main">
          {item.images.length > 0 ? (
            <div className="detail-image">
              <img src={item.images[0]} alt={`${item.title} 사진`} />
            </div>
          ) : (
            <div className="detail-image detail-image-empty">
              <ImagePlus size={32} strokeWidth={1.4} />
              <span>등록된 사진이 없습니다</span>
            </div>
          )}
          {item.images.length > 1 && (
            <div className="detail-thumbnails">
              {item.images.slice(1).map((image, index) => (
                <img key={image} src={image} alt={`${item.title} 사진 ${index + 2}`} />
              ))}
            </div>
          )}
          <div className="detail-copy">
            <div className="detail-title-row">
              <h3>{item.title}</h3>
              <StatusBadge status={item.status} />
            </div>
            <p className="detail-description">{item.description}</p>
            <div className="detail-info">
              <p><span>물건 분류</span><strong>{item.category}</strong></p>
              {item.foundLocation && (
                <p><span>찾은 장소</span><strong>{item.foundLocation}</strong></p>
              )}
              {item.storageLocation && (
                <p><span>보관 장소</span><strong>{item.storageLocation}</strong></p>
              )}
              <p><span>작성자</span><strong>{item.nickname}</strong></p>
              <p><span>등록일</span><strong>{formatDate(item.createdAt)}</strong></p>
            </div>
          </div>
        </div>
        <aside className="comments-panel">
          <h3><MessageCircle size={18} /> 댓글 <span>{item.comments.length}</span></h3>
          <div className="comment-list">
            {item.comments.length ? (
              (commentsByParent.get(null) ?? []).map((entry) => renderComment(entry))
            ) : (
              <p className="no-comments">아직 댓글이 없습니다.</p>
            )}
          </div>
          <form className="comment-form" onSubmit={submitComment}>
            {replyTo && (
              <div className="replying-to">
                <span>{item.comments.find((entry) => entry.id === replyTo)?.nickname}님에게 답글 작성 중</span>
                <button type="button" className="text-button" onClick={() => setReplyTo(null)}>취소</button>
              </div>
            )}
            <div className="credential-fields comment-credentials">
              <div>
                <label className="field-label" htmlFor="comment-nickname">닉네임</label>
                <input
                  id="comment-nickname"
                  className="text-input"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  placeholder="익명"
                  maxLength={20}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="comment-password">비밀번호 <span className="required">*</span></label>
                <input
                  id="comment-password"
                  type="password"
                  className="text-input"
                  value={commentPassword}
                  onChange={(event) => setCommentPassword(event.target.value)}
                  minLength={4}
                  maxLength={128}
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>
            <label className="field-label" htmlFor="comment-content">댓글</label>
            <textarea
              id="comment-content"
              className="text-input comment-input"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="댓글을 남겨 주세요."
              maxLength={300}
              required
            />
            {item.board === "lost" && (
              <>
                <input
                  ref={commentFileInput}
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(event) => {
                    const selected = Array.from(event.target.files ?? []);
                    if (selected.length + commentImages.length > 3) {
                      setError("사진은 댓글당 최대 3장까지 등록할 수 있습니다.");
                    } else if (selected.some((file) => file.size > 5 * 1024 * 1024)) {
                      setError("사진 한 장의 용량은 5MB 이하여야 합니다.");
                    } else {
                      setError("");
                      setCommentImages((current) => [...current, ...selected]);
                    }
                    event.target.value = "";
                  }}
                  aria-label="댓글 사진 선택"
                />
                {commentImages.length > 0 && (
                  <div className="comment-photo-list">
                    {commentImages.map((image, index) => (
                      <span key={`${image.name}-${index}`}>
                        {image.name}
                        <button type="button" aria-label={`${image.name} 제거`} onClick={() => setCommentImages((current) => current.filter((_, fileIndex) => fileIndex !== index))}>
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <button className="secondary-button comment-photo-button" type="button" disabled={commentImages.length >= 3} onClick={() => commentFileInput.current?.click()}>
                  <ImagePlus size={15} /> 사진 추가 ({commentImages.length}/3)
                </button>
              </>
            )}
            {error && <p className="field-error" role="alert">{error}</p>}
            <button className="primary-button comment-submit" type="submit" disabled={busy}>댓글 등록</button>
          </form>
        </aside>
        <div className="item-management">
          <div className="item-management-title">
            <strong>게시글 관리</strong>
            <span>게시글 비밀번호를 입력해 인증해 주세요.</span>
          </div>
          <div className="management-controls">
            <input
              className="text-input management-password"
              type="password"
              placeholder="게시글 비밀번호"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
            <select className="text-input management-status" value={nextStatus} onChange={(event) => setNextStatus(event.target.value as ItemStatus)}>
              {statusOptions[item.board].map((option) => <option value={option} key={option}>{statusLabels[option]}</option>)}
            </select>
            <button className="secondary-button" type="button" disabled={busy || !password} onClick={() => void update("status")}>상태 변경</button>
            <button className="secondary-button" type="button" disabled={busy || !password} onClick={() => void update("bump")}><ArrowUp size={15} /> 끌어올리기</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing((current) => !current)}><Pencil size={15} /> 수정</button>
            <button className="secondary-button delete-button" type="button" disabled={busy || !password} onClick={() => void deletePost()}><Trash2 size={15} /> 삭제</button>
          </div>
          {editing && (
            <div className="edit-fields">
              <input className="text-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} aria-label="물건 이름 수정" />
              <textarea className="text-input" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600} aria-label="특징 수정" />
              <select className="text-input" value={category} onChange={(event) => setCategory(event.target.value as ItemCategory)} aria-label="물건 분류 수정">
                {itemCategories.map((option) => <option value={option} key={option}>{option}</option>)}
              </select>
              {item.board === "found" && (
                <div className="two-fields">
                  <input className="text-input" value={foundLocation} onChange={(event) => setFoundLocation(event.target.value)} aria-label="찾은 장소 수정" />
                  <input className="text-input" value={storageLocation} onChange={(event) => setStorageLocation(event.target.value)} aria-label="보관 장소 수정" />
                </div>
              )}
              <button className="primary-button" type="button" disabled={busy || !password} onClick={() => void update("edit")}>수정 저장</button>
            </div>
          )}
          {error && <p className="field-error management-error" role="alert">{error}</p>}
        </div>
      </div>
    </DialogFrame>
  );

  function renderComment(entry: (typeof item.comments)[number], depth = 0): React.ReactNode {
    return (
      <div className={`comment-thread ${depth > 0 ? "comment-reply" : ""}`} key={entry.id}>
        <article className="comment">
          <div className="comment-meta">
            <strong>{entry.nickname}</strong>
            <time>{formatDate(entry.createdAt)}</time>
            <button
              className="comment-delete"
              type="button"
              aria-label="댓글 삭제"
              onClick={async () => {
                const enteredPassword = window.prompt("댓글 비밀번호를 입력해 주세요.");
                if (!enteredPassword) return;
                setError("");
                try {
                  await onCommentDelete(item.id, entry.id, enteredPassword);
                } catch (reason) {
                  setError(reason instanceof Error ? reason.message : "댓글을 삭제하지 못했습니다.");
                }
              }}
            >
              <X size={13} />
            </button>
          </div>
          <p>{entry.content}</p>
          {entry.images.length > 0 && (
            <div className="comment-images">
              {entry.images.map((image) => <a href={image} target="_blank" rel="noreferrer" key={image}><img src={image} alt="댓글에 첨부한 사진" /></a>)}
            </div>
          )}
          <button className="comment-reply-button" type="button" onClick={() => setReplyTo(entry.id)}>답글</button>
        </article>
        {(commentsByParent.get(entry.id) ?? []).map((reply) => renderComment(reply, depth + 1))}
      </div>
    );
  }
}

function WriteDialog({
  board,
  onClose,
  onSubmit,
}: {
  board: BoardType;
  onClose: () => void;
  onSubmit: (data: FormData) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [foundLocation, setFoundLocation] = useState("");
  const [storageLocation, setStorageLocation] = useState("");
  const [nickname, setNickname] = useState("");
  const [category, setCategory] = useState<ItemCategory | "">("");
  const [status, setStatus] = useState<ItemStatus>(
    board === "found" ? "stored" : "searching",
  );
  const [images, setImages] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function selectImages(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setFileError("");
    if (files.length + images.length > 3) {
      setFileError("사진은 최대 3장까지 등록할 수 있습니다.");
      event.target.value = "";
      return;
    }
    if (files.some((file) => !file.type.startsWith("image/"))) {
      setFileError("이미지 파일만 등록할 수 있습니다.");
      event.target.value = "";
      return;
    }
    if (files.some((file) => file.size > 5 * 1024 * 1024)) {
      setFileError("사진 한 장의 용량은 5MB 이하여야 합니다.");
      event.target.value = "";
      return;
    }
    setSelectedFiles((current) => [...current, ...files]);
    setImages((current) => [...current, ...files.map((file) => URL.createObjectURL(file))]);
    event.target.value = "";
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError("");
    setBusy(true);
    const data = new FormData();
    data.set("board", board);
    data.set("category", category);
    data.set("title", title.trim());
    data.set("description", description.trim());
    data.set("nickname", nickname.trim() || "익명");
    data.set("password", password);
    data.set("status", status);
    if (board === "found") {
      data.set("foundLocation", foundLocation.trim());
      data.set("storageLocation", storageLocation.trim() || foundLocation.trim());
    }
    selectedFiles.forEach((file) => data.append("photos", file));
    try {
      await onSubmit(data);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "게시글을 등록하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogFrame
      title={board === "found" ? "습득물 올리기" : "분실물 올리기"}
      onClose={onClose}
    >
      <form className="write-form" onSubmit={submit}>
        <div className="form-scroll">
          <p className="form-description">
            {board === "found"
              ? "주인을 찾을 수 있도록 물건의 특징과 보관 장소를 적어 주세요."
              : "찾고 있는 물건의 특징을 자세히 적어 주세요."}
          </p>
          <label className="field-label" htmlFor="item-title">물건 이름 <span className="required">*</span></label>
          <input
            id="item-title"
            className="text-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={60}
            placeholder="예: 검정색 무선 이어폰"
            required
          />
          <label className="field-label" htmlFor="item-description">특징 <span className="required">*</span></label>
          <textarea
            id="item-description"
            className="text-input description-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={600}
            placeholder="색상, 모양, 눈에 띄는 특징을 적어 주세요."
            required
          />
          {board === "found" && (
            <div className="two-fields">
              <div>
                <label className="field-label" htmlFor="found-location">찾은 장소 <span className="required">*</span></label>
                <input
                  id="found-location"
                  className="text-input"
                  value={foundLocation}
                  onChange={(event) => setFoundLocation(event.target.value)}
                  maxLength={80}
                  placeholder="예: 본관 2층"
                  required
                />
              </div>
              <div>
                <label className="field-label" htmlFor="storage-location">보관 장소</label>
                <input
                  id="storage-location"
                  className="text-input"
                  value={storageLocation}
                  onChange={(event) => setStorageLocation(event.target.value)}
                  maxLength={80}
                  placeholder={foundLocation || "찾은 장소와 같으면 비워 두세요"}
                />
              </div>
            </div>
          )}
          <div className="credential-fields item-credentials">
            <div>
              <label className="field-label" htmlFor="item-nickname">닉네임</label>
              <input
                id="item-nickname"
                className="text-input"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={20}
                placeholder="익명"
              />
            </div>
            <div>
              <label className="field-label" htmlFor="item-password">비밀번호 <span className="required">*</span></label>
              <input
                id="item-password"
                className="text-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={4}
                maxLength={128}
                autoComplete="new-password"
                placeholder="수정·삭제·상태 변경에 사용합니다"
                required
              />
            </div>
          </div>
          <label className="field-label" htmlFor="item-category">물건 분류 <span className="required">*</span></label>
          <select
            id="item-category"
            className="text-input"
            value={category}
            onChange={(event) => setCategory(event.target.value as ItemCategory | "")}
            required
          >
            <option value="" disabled>분류를 선택해 주세요</option>
            {itemCategories.map((option) => <option value={option} key={option}>{option}</option>)}
          </select>
          <label className="field-label" htmlFor="item-status">진행 상태</label>
          <select
            id="item-status"
            className="text-input status-select"
            value={status}
            onChange={(event) => setStatus(event.target.value as ItemStatus)}
          >
            {statusOptions[board].map((option) => (
              <option value={option} key={option}>{statusLabels[option]}</option>
            ))}
          </select>
          <span className="field-label">사진 <span>(선택 · 최대 3장)</span></span>
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept="image/*"
            multiple
            onChange={selectImages}
            aria-label="사진 선택"
          />
          <div className="photo-picker">
            {images.map((image, index) => (
              <div className="photo-preview" key={image}>
                <img src={image} alt={`선택한 사진 ${index + 1}`} />
                <button
                  type="button"
                  aria-label={`사진 ${index + 1} 제거`}
                  onClick={() => {
                    URL.revokeObjectURL(image);
                    setImages((current) => current.filter((entry) => entry !== image));
                    setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {images.length < 3 && (
              <button
                type="button"
                className="photo-add"
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlus size={21} />
                <span>사진 추가</span>
              </button>
            )}
          </div>
          {fileError && <p className="field-error" role="alert">{fileError}</p>}

          {submitError && <p className="field-error" role="alert">{submitError}</p>}
        </div>
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={onClose}>취소</button>
          <button type="submit" className="primary-button" disabled={busy}><Check size={17} /> {busy ? "등록 중..." : "게시글 등록"}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

function AdminDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setupRequired, setSetupRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [items, setItems] = useState<LostFoundItem[]>([]);
  const [bannedWords, setBannedWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState("");
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [needsPasswordChange, setNeedsPasswordChange] = useState(false);

  async function loadAdminData() {
    const [adminItems, words] = await Promise.all([
      adminRequest<LostFoundItem[]>("/api/admin/items"),
      adminRequest<{ word: string }[]>("/api/admin/banned-words"),
    ]);
    setItems(adminItems);
    setBannedWords(words.map(({ word }) => word));
  }

  useEffect(() => {
    Promise.all([
      adminRequest<AdminMeResponse>("/api/admin/me"),
      adminRequest<{ setupRequired: boolean }>("/api/admin/setup-status"),
    ]).then(async ([me, setup]) => {
      setSetupRequired(setup.setupRequired);
      if (me.authenticated) {
        setAuthenticated(true);
        setUsername(me.username ?? "");
        setNeedsPasswordChange(Boolean(me.needsPasswordChange));
        if (!me.needsPasswordChange) await loadAdminData();
      }
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "관리자 상태를 확인하지 못했습니다."));
  }, []);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const path = setupRequired ? "/api/admin/setup" : "/api/admin/login";
      const result = await adminRequest<{ username: string }>(path, {
        method: "POST",
        body: JSON.stringify(setupRequired
          ? { username, password, setupToken }
          : { username, password }),
      });
      setUsername(result.username);
      setAuthenticated(true);
      setSetupRequired(false);
      setPassword("");
      const me = await adminRequest<AdminMeResponse>("/api/admin/me");
      setNeedsPasswordChange(Boolean(me.needsPasswordChange));
      if (!me.needsPasswordChange) await loadAdminData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "관리자 로그인을 완료하지 못했습니다.");
    }
  }

  async function signOut() {
    await adminRequest<void>("/api/admin/logout", { method: "POST" });
    setAuthenticated(false);
    setItems([]);
    setBannedWords([]);
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPasswordChanged(false);
    try {
      await adminRequest<{ changed: boolean }>("/api/admin/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setNeedsPasswordChange(false);
      setPasswordChanged(true);
      await loadAdminData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "관리자 비밀번호를 변경하지 못했습니다.");
    }
  }

  async function updateStatus(item: LostFoundItem, status: ItemStatus) {
    setError("");
    try {
      const updated = await adminRequest<LostFoundItem>(`/api/admin/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry));
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "상태를 변경하지 못했습니다.");
    }
  }

  async function removePost(item: LostFoundItem) {
    if (!window.confirm(`'${item.title}' 게시글을 삭제할까요?`)) return;
    try {
      await adminRequest<void>(`/api/admin/items/${item.id}`, { method: "DELETE" });
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "게시글을 삭제하지 못했습니다.");
    }
  }

  async function addWord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = await adminRequest<{ word: string }>("/api/admin/banned-words", {
        method: "POST",
        body: JSON.stringify({ word: newWord }),
      });
      setBannedWords((current) => [...new Set([...current, result.word])].sort());
      setNewWord("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "금지어를 추가하지 못했습니다.");
    }
  }

  async function removeWord(word: string) {
    try {
      await adminRequest<void>(`/api/admin/banned-words/${encodeURIComponent(word)}`, { method: "DELETE" });
      setBannedWords((current) => current.filter((entry) => entry !== word));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "금지어를 삭제하지 못했습니다.");
    }
  }

  return (
    <DialogFrame title="관리자" onClose={onClose} wide>
      {authenticated ? (
        <div className="admin-content">
          <div className="admin-topline">
            <span>{username} 로그인</span>
            <button type="button" className="text-button" onClick={() => void signOut()}>로그아웃</button>
          </div>
          <form className="admin-password-form" onSubmit={changePassword}>
            <strong>{needsPasswordChange ? "외부 공개 전 비밀번호 변경이 필요합니다" : "관리자 비밀번호 변경"}</strong>
            {needsPasswordChange && (
              <p className="password-change-warning">
                계정 보호를 위해 추측하기 어려운 16자 이상의 새 비밀번호를 설정해야 관리자 기능과 외부 공개를 사용할 수 있습니다.
              </p>
            )}
            <div className="admin-password-fields">
              <input
                className="text-input"
                type="password"
                placeholder="현재 비밀번호"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
              <input
                className="text-input"
                type="password"
                placeholder="새 비밀번호 (16자 이상)"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={16}
                maxLength={128}
                autoComplete="new-password"
                required
              />
              <button className="secondary-button" type="submit">변경</button>
            </div>
            {passwordChanged && <p className="password-changed" role="status">비밀번호를 변경했습니다.</p>}
          </form>
          <section className="admin-section">
            <h3>게시글 관리 <span>{items.length}</span></h3>
            {items.length ? (
              <div className="admin-list">
                {items.map((item) => (
                  <article className="admin-item" key={item.id}>
                    <div className="admin-item-copy">
                      <span className="admin-board-label">{item.board === "found" ? "습득물" : "분실물"}</span>
                      <strong>{item.title}</strong>
                      <small>{item.nickname} · {formatDate(item.createdAt)}</small>
                    </div>
                    <select
                      className="admin-status-select"
                      value={item.status}
                      aria-label={`${item.title} 상태`}
                      onChange={(event) => void updateStatus(item, event.target.value as ItemStatus)}
                    >
                      {statusOptions[item.board].map((status) => <option value={status} key={status}>{statusLabels[status]}</option>)}
                    </select>
                    <button className="admin-delete-button" type="button" aria-label={`${item.title} 삭제`} onClick={() => void removePost(item)}>
                      <Trash2 size={16} />
                    </button>
                  </article>
                ))}
              </div>
            ) : <p className="admin-empty">등록된 게시글이 없습니다.</p>}
          </section>
          <section className="admin-section">
            <h3>비공개 금지어 <span>{bannedWords.length}</span></h3>
            <form className="banned-word-form" onSubmit={addWord}>
              <input className="text-input" value={newWord} onChange={(event) => setNewWord(event.target.value)} minLength={2} maxLength={40} placeholder="금지어 추가" required />
              <button className="primary-button" type="submit">추가</button>
            </form>
            <div className="banned-word-list">
              {bannedWords.map((word) => (
                <span className="banned-word" key={word}>
                  {word}
                  <button type="button" onClick={() => void removeWord(word)} aria-label={`${word} 삭제`}><X size={13} /></button>
                </span>
              ))}
              {!bannedWords.length && <span className="admin-empty">등록된 금지어가 없습니다.</span>}
            </div>
          </section>
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
      ) : (
        <form className="admin-login" onSubmit={signIn}>
          <p>{setupRequired ? "서버 터미널에 표시된 일회용 설정 토큰으로 최초 관리자 계정을 만드세요." : "관리자 계정으로 로그인하세요."}</p>
          {setupRequired && (
            <>
              <label className="field-label" htmlFor="admin-setup-token">최초 설정 토큰</label>
              <input id="admin-setup-token" className="text-input" value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required />
            </>
          )}
          <label className="field-label" htmlFor="admin-username">아이디</label>
          <input id="admin-username" className="text-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
          <label className="field-label" htmlFor="admin-password">비밀번호 {setupRequired && <span>(12자 이상)</span>}</label>
          <input id="admin-password" className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={setupRequired ? 12 : 1} autoComplete={setupRequired ? "new-password" : "current-password"} required />
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="primary-button admin-login-button" type="submit">{setupRequired ? "관리자 계정 만들기" : "로그인"}</button>
        </form>
      )}
    </DialogFrame>
  );
}

function InfoDialog({ onClose }: { onClose: () => void }) {
  return (
    <DialogFrame title="이용 안내" onClose={onClose}>
      <div className="info-content">
        <p>광주과학고등학교 분실물 게시판입니다.</p>
        <ul>
          <li>습득물과 분실물을 나누어 확인할 수 있습니다.</li>
          <li>물건 이름과 특징으로 검색하고 상태별로 필터링할 수 있습니다.</li>
          <li>사진은 선택 사항이며, 한 게시글에 최대 3장까지 선택할 수 있습니다.</li>
          <li>게시글은 자동으로 삭제되지 않습니다.</li>
          <li>광주과학고 42기 정보부 제작</li>
        </ul>
        <button className="primary-button info-close" onClick={onClose}>
          확인
        </button>
      </div>
    </DialogFrame>
  );
}

export default App;
