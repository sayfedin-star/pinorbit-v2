export interface PaginationResult<T> {
  pagedItems: T[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  startIndex: number;
  endIndex: number;
  pageStart: number;
  pageEnd: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Pure pagination calculator for client-side tabular datasets.
 * Handles page boundary clamping, partial trailing pages, and empty states.
 */
export function paginateItems<T>(items: T[], requestedPage = 1, pageSize = 50): PaginationResult<T> {
  const safeItems = Array.isArray(items) ? items : [];
  const totalItems = safeItems.length;
  const safePageSize = Math.max(1, Math.floor(pageSize) || 50);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.max(1, Math.min(Math.floor(requestedPage) || 1, totalPages));

  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalItems);
  const pagedItems = safeItems.slice(startIndex, endIndex);

  const pageStart = totalItems === 0 ? 0 : startIndex + 1;
  const pageEnd = totalItems === 0 ? 0 : endIndex;

  return {
    pagedItems,
    totalItems,
    totalPages,
    currentPage,
    pageSize: safePageSize,
    startIndex,
    endIndex,
    pageStart,
    pageEnd,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}
