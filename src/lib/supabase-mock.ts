import type {
  Account,
  Board,
  Pin,
  Log,
  AuditLog,
  AccountWebhook,
  ImportSession,
} from './types';

// Mock Data used only as preview fallback when Supabase env is not configured
export let mockAccounts: Account[] = [
  {
    id: 'acc-1',
    account_name: 'HealthyBites_US',
    webhook_url: 'https://hook.make.com/abc123healthy1',
    max_pins_per_day: 20,
    is_active: true,
    pinning_started_at: new Date(Date.now() - 86400000 * 15).toISOString(),
    posting_window_start: '09:00',
    posting_window_end: '21:00',
    timezone: 'America/New_York',
    created_at: new Date(Date.now() - 86400000 * 10).toISOString(),
    boards_count: 3,
    webhooks_count: 2,
    active_webhooks_count: 2,
    primary_webhook_label: 'Primary Hook',
  },
  {
    id: 'acc-2',
    account_name: 'DessertLovers_Global',
    webhook_url: 'https://hook.make.com/def456dessert2',
    max_pins_per_day: 15,
    is_active: true,
    pinning_started_at: new Date(Date.now() - 86400000 * 30).toISOString(),
    posting_window_start: '10:00',
    posting_window_end: '22:00',
    timezone: 'Europe/London',
    created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    boards_count: 2,
    webhooks_count: 1,
    active_webhooks_count: 1,
    primary_webhook_label: 'Primary',
  },
  {
    id: 'acc-3',
    account_name: 'KetoRecipes_Hub',
    webhook_url: 'https://hook.make.com/ghi789keto3',
    max_pins_per_day: 25,
    is_active: false,
    pinning_started_at: null,
    posting_window_start: '08:00',
    posting_window_end: '20:00',
    timezone: 'UTC',
    created_at: new Date(Date.now() - 86400000 * 4).toISOString(),
    boards_count: 4,
    webhooks_count: 1,
    active_webhooks_count: 0,
    primary_webhook_label: 'Backup Hook',
  },
];

export let mockWebhooks: AccountWebhook[] = [
  {
    id: 'hook-1',
    account_id: 'acc-1',
    label: 'Primary Hook',
    webhook_url: 'https://hook.make.com/abc123healthy1',
    monthly_capacity: 500,
    monthly_usage: 45,
    remaining_capacity: 455,
    priority: 1,
    is_active: true,
    is_primary: true,
    last_used_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    last_failed_at: null,
    last_failure_reason: null,
    created_at: new Date(Date.now() - 86400000 * 10).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 10).toISOString(),
  },
  {
    id: 'hook-2',
    account_id: 'acc-1',
    label: 'Secondary Channel',
    webhook_url: 'https://hook.make.com/abc123healthy2',
    monthly_capacity: 500,
    monthly_usage: 0,
    remaining_capacity: 500,
    priority: 2,
    is_active: true,
    is_primary: false,
    last_used_at: null,
    last_failed_at: null,
    last_failure_reason: null,
    created_at: new Date(Date.now() - 86400000 * 5).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 5).toISOString(),
  },
  {
    id: 'hook-3',
    account_id: 'acc-2',
    label: 'Primary',
    webhook_url: 'https://hook.make.com/def456dessert2',
    monthly_capacity: 500,
    monthly_usage: 120,
    remaining_capacity: 380,
    priority: 1,
    is_active: true,
    is_primary: true,
    last_used_at: new Date(Date.now() - 3600000 * 5).toISOString(),
    last_failed_at: null,
    last_failure_reason: null,
    created_at: new Date(Date.now() - 86400000 * 7).toISOString(),
    updated_at: new Date(Date.now() - 86400000 * 7).toISOString(),
  },
];

export let mockBoards: Board[] = [
  {
    id: 'board-1',
    account_id: 'acc-1',
    board_name: 'Quick Dinner Recipes',
    board_id: '1092837465',
    created_at: new Date(Date.now() - 86400000 * 9).toISOString(),
    account_name: 'HealthyBites_US',
  },
  {
    id: 'board-2',
    account_id: 'acc-1',
    board_name: 'Healthy Meal Prep',
    board_id: '1092837466',
    created_at: new Date(Date.now() - 86400000 * 9).toISOString(),
    account_name: 'HealthyBites_US',
  },
  {
    id: 'board-3',
    account_id: 'acc-2',
    board_name: 'Easy Chocolate Desserts',
    board_id: '2092837467',
    created_at: new Date(Date.now() - 86400000 * 6).toISOString(),
    account_name: 'DessertLovers_Global',
  },
];

export let mockPins: Pin[] = [
  {
    id: 'pin-1',
    account_id: 'acc-1',
    title: '30-Minute Creamy Garlic Chicken',
    description: 'Easy and delicious one-pan creamy garlic chicken recipe perfect for busy weeknights.',
    image_url: 'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=600&q=80',
    board_name: 'Quick Dinner Recipes',
    link: 'https://myrecipeblog.com/creamy-garlic-chicken',
    status: 'posted',
    source: 'google_sheets',
    posted_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    scheduled_for: null,
    created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 0,
    max_retries: 3,
  },
  {
    id: 'pin-2',
    account_id: 'acc-1',
    title: 'Keto Cauliflower Rice Bowl',
    description: 'Low carb cauliflower bowl with avocado, roasted chickpeas and tahini dressing.',
    image_url: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80',
    board_name: 'Healthy Meal Prep',
    link: 'https://myrecipeblog.com/cauliflower-bowl',
    status: 'pending',
    source: 'google_sheets',
    posted_at: null,
    scheduled_for: new Date(Date.now() + 3600000 * 4).toISOString(),
    created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 0,
    max_retries: 3,
  },
  {
    id: 'pin-3',
    account_id: 'acc-1',
    title: 'Matcha Green Tea Smoothie Bowl',
    description: 'Antioxidant packed smoothie bowl with kiwi, chia seeds and coconut flakes.',
    image_url: 'https://images.unsplash.com/photo-1590301157890-4810ed352733?auto=format&fit=crop&w=600&q=80',
    board_name: 'Healthy Meal Prep',
    link: 'https://myrecipeblog.com/matcha-smoothie',
    status: 'pending',
    source: 'csv_upload',
    posted_at: null,
    scheduled_for: new Date(Date.now() + 3600000 * 1).toISOString(),
    created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 1,
    max_retries: 3,
    next_retry_at: new Date(Date.now() + 3600000 * 0.25).toISOString(),
    last_failure_reason: 'Webhook dispatch timed out (504 Gateway Timeout)',
    last_attempt_at: new Date(Date.now() - 3600000 * 0.5).toISOString(),
    failure_type: 'transient',
  },
  {
    id: 'pin-4',
    account_id: 'acc-1',
    title: 'Avocado Toast with Poached Eggs',
    description: 'Crispy sourdough topped with smashed avocado, red pepper flakes and poached eggs.',
    image_url: 'https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&w=600&q=80',
    board_name: 'Breakfast & Brunch',
    link: 'https://myrecipeblog.com/avocado-toast',
    status: 'failed',
    source: 'google_sheets',
    posted_at: null,
    scheduled_for: null,
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 3,
    max_retries: 3,
    next_retry_at: null,
    last_failure_reason: 'HTTP 400 Bad Request: Invalid board ID provided',
    last_attempt_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    failure_type: 'permanent',
  },
  {
    id: 'pin-5',
    account_id: 'acc-1',
    title: 'Berry Protein Pancake Stack',
    description: 'Fluffy high-protein pancakes served with fresh blueberry syrup.',
    image_url: 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?auto=format&fit=crop&w=600&q=80',
    board_name: 'Breakfast & Brunch',
    link: 'https://myrecipeblog.com/protein-pancakes',
    status: 'posted',
    source: 'google_sheets',
    posted_at: new Date(Date.now() - 3600000 * 18).toISOString(),
    scheduled_for: null,
    created_at: new Date(Date.now() - 3600000 * 30).toISOString(),
    account_name: 'HealthyBites_US',
    retry_count: 0,
    max_retries: 3,
  },
];

export let mockLogs: Log[] = [];
export let mockAuditLogs: AuditLog[] = [];
export let mockImportSessions: ImportSession[] = [];

export interface RawAccount extends Account {
  boards?: { id: string }[];
  account_webhooks?: {
    id: string;
    label: string;
    is_active: boolean;
    is_primary: boolean;
  }[];
}

export interface RawBoard extends Board {
  accounts?: { account_name: string } | null;
}

export interface RawPin extends Pin {
  accounts?: { account_name: string } | null;
}

export interface RawLog extends Log {
  accounts?: { account_name: string } | null;
  pins?: { title: string } | null;
  account_webhooks?: { label: string } | null;
}

export const DEFAULT_WS_ID = '00000000-0000-0000-0000-000000000001';

export function matchesWorkspace(entityWsId?: string, targetWsId?: string): boolean {
  if (!targetWsId) return true;
  const actualWs = entityWsId || DEFAULT_WS_ID;
  return actualWs === targetWsId;
}

export function setMockAccounts(accounts: Account[]) {
  mockAccounts = accounts;
}

export function setMockWebhooks(webhooks: AccountWebhook[]) {
  mockWebhooks = webhooks;
}

export function setMockBoards(boards: Board[]) {
  mockBoards = boards;
}

export function setMockPins(pins: Pin[]) {
  mockPins = pins;
}
