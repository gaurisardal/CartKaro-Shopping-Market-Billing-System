/**
 * CartKaro - Supermarket Inventory & Billing Management System
 * Vanilla JavaScript front end on top of Supabase (PostgreSQL).
 * Technology Stack: HTML5, CSS3, JavaScript (ES6+), Bootstrap 5, Chart.js, Supabase JS v2
 *
 * DATA MODEL: Supabase is the single source of truth. Products, inventory, bills,
 * bill items, payments, customers and stock movements are read from and written to
 * the database (writes go through the RPC functions in cartkaro_fix.sql so every
 * operation is atomic). The in-memory CartKaroStore below is only a cache of the
 * last successful database read; nothing but shop settings is kept in LocalStorage.
 */

// ==========================================================================
// 1. SOUND SYNTHESIZER (Web Audio API - Zero External Assets)
// ==========================================================================
const SoundFx = {
  ctx: null,
  init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },
  beep(freq = 1200, duration = 0.08, type = 'sine') {
    try {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.12, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) { /* ignore audio failure */ }
  },
  successChime() {
    try {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.08, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.07 + 0.15);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + i * 0.07 + 0.16);
      });
    } catch (e) { /* ignore audio failure */ }
  },
  alertTone() {
    try {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(300, this.ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(150, this.ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.2);
    } catch (e) { /* ignore audio failure */ }
  }
};

// ==========================================================================
// 2. DATA STORE & LOCAL STORAGE ENGINE
// ==========================================================================
const STORAGE_KEYS = {
  PRODUCTS: 'cartkaro_products',
  BILLS: 'cartkaro_bills',
  MOVEMENTS: 'cartkaro_movements',
  SETTINGS: 'cartkaro_settings'
};

const DEFAULT_SETTINGS = {
  shopName: 'CartKaro Supermarket',
  tagline: 'Fresh Groceries & Daily Needs',
  address: 'Shop 12-14, MG Road Market, Bengaluru, Karnataka 560001',
  phone: '+91 98765 43210',
  email: 'support@cartkaro.local',
  gstin: '29ABCDE1234F1Z5',
  currency: '₹',
  defaultGst: 5,
  defaultDiscount: 0,
  lowStockThreshold: 10,
  footerMsg: 'Thank you for shopping at CartKaro! Visit again.'
};

const CartKaroStore = {
  // In-memory cache of what was last read from Supabase. NOT persisted anywhere.
  _products: [],
  _bills: [],
  _movements: [],

  getProducts() { return this._products; },
  setProducts(products) { this._products = Array.isArray(products) ? products : []; },
  getBills() { return this._bills; },
  setBills(bills) { this._bills = Array.isArray(bills) ? bills : []; },
  getMovements() { return this._movements; },
  setMovements(movs) { this._movements = Array.isArray(movs) ? movs : []; },
  clearData() {
    this._products = [];
    this._bills = [];
    this._movements = [];
  },

  // Shop settings (name, address, GST defaults...) have no database table, so they stay local.
  getSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch (e) {
      console.error('Could not read saved settings, using defaults:', e);
      return { ...DEFAULT_SETTINGS };
    }
  },
  saveSettings(settings) {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  },

  // Old versions of this app kept demo products/bills/movements in LocalStorage.
  // Remove them so stale demo data can never be shown as if it were real.
  purgeLegacyLocalData() {
    try {
      localStorage.removeItem(STORAGE_KEYS.PRODUCTS);
      localStorage.removeItem(STORAGE_KEYS.BILLS);
      localStorage.removeItem(STORAGE_KEYS.MOVEMENTS);
    } catch (e) { /* storage unavailable - nothing to purge */ }
  }
};

CartKaroStore.purgeLegacyLocalData();

// ==========================================================================
// 2B. SUPABASE DATABASE & AUTH SERVICE
// ==========================================================================
const SUPABASE_CONFIG = {
  url: 'https://ywobsbogfesnvsgqbhej.supabase.co',
  key: 'sb_publishable_D-yGBoQjEl8mllO31ebrJw_ZU6yJCZo'
};

const SupabaseService = {
  client: null,
  isConnected: false,
  isAuthenticated: false,
  currentUser: null,
  lastRlsStatus: null, // null | 'ok' | 'restricted' | 'error'
  lastError: null,

  init() {
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      try {
        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true
          }
        });
        this.isConnected = true;
        this.checkAuth();
      } catch (err) {
        console.error('Failed to initialize Supabase client:', err);
        this.isConnected = false;
        this.lastError = err;
      }
    } else {
      console.warn('Supabase JS SDK not loaded yet.');
    }
  },

  async checkAuth() {
    if (!this.client) return null;
    try {
      const { data } = await this.client.auth.getSession();
      if (data && data.session && data.session.user) {
        this.isAuthenticated = true;
        this.currentUser = data.session.user;
      } else {
        this.isAuthenticated = false;
        this.currentUser = null;
      }
      this.updateStatusBadge();
      return this.currentUser;
    } catch (e) {
      this.isAuthenticated = false;
      return null;
    }
  },

  updateStatusBadge() {
    const badge = document.getElementById('supabase-status-badge');
    const textEl = document.getElementById('supabase-status-text');
    const iconEl = document.getElementById('supabase-status-icon');
    const sessionStatusEl = document.getElementById('modal-sb-session-status');
    const logoutBtn = document.getElementById('btn-sb-logout');
    const loginBtn = document.getElementById('btn-sb-login');

    if (!badge || !textEl) return;

    if (this.isAuthenticated && this.currentUser) {
      badge.className = 'btn btn-sm btn-outline-success border d-flex align-items-center gap-1';
      textEl.textContent = `Staff: ${this.currentUser.email.split('@')[0]}`;
      if (iconEl) iconEl.className = 'bi bi-person-check-fill text-success';
      if (sessionStatusEl) sessionStatusEl.innerHTML = `<span class="text-success fw-bold">Staff Authenticated</span> (${esc(this.currentUser.email)})`;
      if (logoutBtn) logoutBtn.classList.remove('d-none');
      if (loginBtn) loginBtn.classList.add('d-none');
    } else if (this.isConnected) {
      badge.className = 'btn btn-sm btn-outline-primary border d-flex align-items-center gap-1';
      textEl.textContent = 'Supabase: Connected';
      if (iconEl) iconEl.className = 'bi bi-database text-primary';
      if (sessionStatusEl) sessionStatusEl.innerHTML = '<span class="text-warning fw-bold">Unauthenticated (Guest)</span>';
      if (logoutBtn) logoutBtn.classList.add('d-none');
      if (loginBtn) loginBtn.classList.remove('d-none');
    } else {
      badge.className = 'btn btn-sm btn-outline-secondary border d-flex align-items-center gap-1';
      textEl.textContent = 'Supabase: Offline';
      if (iconEl) iconEl.className = 'bi bi-database-slash text-muted';
      if (sessionStatusEl) sessionStatusEl.textContent = 'Disconnected';
      if (logoutBtn) logoutBtn.classList.add('d-none');
      if (loginBtn) loginBtn.classList.remove('d-none');
    }
  },

  /**
   * Product fetching (products joined with inventory).
   * Only active products are listed; archived products stay in the database
   * so old bills keep their history.
   */
  async fetchProducts() {
    if (!this.client) {
      return { error: { message: 'Supabase client not initialized' } };
    }

    try {
      const PAGE = 1000;
      let from = 0;
      let rows = [];
      for (;;) {
        const { data, error } = await this.client
          .from('products')
          .select('product_id, product_name, barcode, category, price, tax_rate, unit, cost_price, supplier, expiry_date, is_active, inventory(quantity, reorder_level, last_updated)')
          .eq('is_active', true)
          .order('product_id', { ascending: true })
          .range(from, from + PAGE - 1);

        if (error) {
          this.lastRlsStatus = 'error';
          this.lastError = error;
          console.error('[CartKaro] fetchProducts failed:', error);
          return { error };
        }
        rows = rows.concat(data || []);
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }

      if (rows.length === 0) {
        const session = await this.checkAuth();
        this.lastRlsStatus = session ? 'empty_table' : 'restricted';
        return { data: [], isRlsRestricted: !session };
      }

      this.lastRlsStatus = 'ok';

      // Map Supabase columns to the frontend JavaScript product model
      const mapped = rows.map(p => {
        const inv = Array.isArray(p.inventory) ? p.inventory[0] : p.inventory;
        const sellingPrice = parseFloat(p.price || 0);
        const hasCost = p.cost_price !== null && p.cost_price !== undefined;
        return {
          id: 'PRD-' + p.product_id,
          dbId: p.product_id,
          name: p.product_name,
          barcode: p.barcode || ('890103' + String(p.product_id).padStart(7, '0')),
          category: p.category,
          sellingPrice: sellingPrice,
          costPrice: hasCost ? parseFloat(p.cost_price) : parseFloat((sellingPrice * 0.8).toFixed(2)),
          taxRate: parseFloat(p.tax_rate || 0),
          unit: p.unit || 'pack',
          quantity: inv ? parseFloat(inv.quantity || 0) : 0,
          minStock: inv ? parseFloat(inv.reorder_level || 10) : 10,
          supplier: p.supplier || '',
          expiryDate: p.expiry_date || '',
          fromSupabase: true
        };
      });

      return { data: mapped, isRlsRestricted: false };
    } catch (err) {
      console.error('Supabase fetch exception:', err);
      this.lastRlsStatus = 'error';
      this.lastError = err;
      return { error: err };
    }
  },

  async signIn(email, password) {
    if (!this.client) return { error: { message: 'Supabase client not initialized' } };
    try {
      const res = await this.client.auth.signInWithPassword({ email, password });
      if (res.data?.session) {
        this.isAuthenticated = true;
        this.currentUser = res.data.session.user;
        this.updateStatusBadge();
      }
      return res;
    } catch (err) {
      return { error: err };
    }
  },

  async signOut() {
    if (!this.client) return;
    await this.client.auth.signOut();
    this.isAuthenticated = false;
    this.currentUser = null;
    this.updateStatusBadge();
  }
};

// ==========================================================================
// 2C. DATABASE ACCESS LAYER (reads, RPC writes, error handling, cache refresh)
// ==========================================================================
class DbError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'DbError';
    this.code = code || null;
    this.cause = cause || null;
  }
}

// Turn a Supabase / PostgreSQL / network error into a message a cashier can act on.
function describeDbError(err) {
  const raw = (err && err.message) ? String(err.message) : String(err || 'Unknown error');
  const code = err && err.code ? String(err.code) : '';

  // Errors raised on purpose by the functions in cartkaro_fix.sql look like "CODE: message".
  const known = raw.match(/^(INSUFFICIENT_STOCK|INSUFFICIENT_PAYMENT|INVALID_[A-Z_]+|EMPTY_CART|PRODUCT_NOT_FOUND|BILL_NOT_FOUND|BILL_NOT_VOIDABLE|ALLOCATION_ERROR):\s*([\s\S]*)$/);
  if (known) return known[2];

  if (code === 'PGRST202' || /Could not find the function/i.test(raw)) {
    return 'The database is missing the CartKaro functions. Run cartkaro_fix.sql in the Supabase SQL Editor, then reload this page.';
  }
  if (code === '42703' || /column .* does not exist/i.test(raw)) {
    return 'The database is missing columns added by cartkaro_fix.sql. Run that file in the Supabase SQL Editor, then reload this page.';
  }
  if (code === '23505') {
    return /barcode/i.test(raw)
      ? 'This barcode is already used by another product.'
      : 'A record with the same unique value already exists.';
  }
  if (code === '23503') return 'This record is linked to other data and cannot be changed this way.';
  if (code === '23514') return 'The database rejected a value that is out of range (' + raw + ').';
  if (code === '42501' || /row-level security|permission denied/i.test(raw)) {
    return 'The database refused this action (security policy). Sign in with a staff account and try again.';
  }
  if (/JWT|token is expired|not authenticated/i.test(raw)) {
    return 'Your staff session has expired. Sign in again and retry.';
  }
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw)) {
    return 'Cannot reach Supabase. Check the internet connection and retry.';
  }
  return raw;
}

function wrapDbError(err) {
  if (err instanceof DbError) return err;
  return new DbError(describeDbError(err), err && err.code, err);
}

function toNum(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isNaN(n) ? fallback : n;
}
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function newRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const b = new Uint8Array(16);
  (window.crypto || window.msCrypto).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const PAYMENT_LABELS = { CASH: 'Cash', CARD: 'Card', UPI: 'UPI' };
const BILL_STATUS_LABELS = { PAID: 'Completed', CANCELLED: 'Returned', REFUNDED: 'Returned', PENDING: 'Pending' };

// Build the frontend bill shape (used by dashboard, sales history, receipts, reports)
function buildBillModel(src) {
  const subtotal = toNum(src.subtotal);
  const discountAmount = toNum(src.discount);
  const gstAmount = toNum(src.tax_amount);
  const taxable = subtotal - discountAmount;
  const grandTotal = toNum(src.grand_total);
  const gstRate = src.gst_rate !== null && src.gst_rate !== undefined
    ? toNum(src.gst_rate)
    : (taxable > 0 ? round2((gstAmount / taxable) * 100) : 0);
  const method = PAYMENT_LABELS[String(src.payment_method || '').toUpperCase()] || src.payment_method || '';
  const isCash = method === 'Cash';
  const tendered = src.amount_tendered !== null && src.amount_tendered !== undefined ? toNum(src.amount_tendered) : grandTotal;

  return {
    billId: src.bill_id,
    billNo: src.bill_number || ('BILL-' + (1000 + Number(src.bill_id))),
    date: new Date(src.bill_date).toISOString(),
    customerId: src.customer_id || null,
    customerName: src.customer_name || 'Walk-in Customer',
    customerPhone: src.customer_phone || '',
    items: src.items,
    subtotal,
    discountType: src.discount_type || 'fixed',
    discountValue: src.discount_value !== null && src.discount_value !== undefined ? toNum(src.discount_value) : discountAmount,
    discountAmount,
    gstRate,
    gstAmount,
    grandTotal,
    paymentMethod: method,
    amountPaid: isCash ? tendered : grandTotal,
    changeDue: isCash && src.change_due !== null && src.change_due !== undefined ? toNum(src.change_due) : 0,
    cardRef: src.reference || '',
    status: BILL_STATUS_LABELS[src.status] || src.status || 'Completed'
  };
}

function buildBillItem(i, prodName, prodBarcode, prodCost) {
  const rate = toNum(i.unit_price);
  const quantity = toNum(i.quantity);
  return {
    productId: 'PRD-' + i.product_id,
    dbId: i.product_id,
    name: prodName || ('Product #' + i.product_id),
    barcode: prodBarcode || '',
    rate,
    quantity,
    amount: round2(rate * quantity),
    costPrice: prodCost !== null && prodCost !== undefined ? toNum(prodCost) : round2(rate * 0.8)
  };
}

// Row from the nested bills select
function mapBillRow(b) {
  const customer = Array.isArray(b.customers) ? b.customers[0] : b.customers;
  const pays = Array.isArray(b.payments) ? b.payments : (b.payments ? [b.payments] : []);
  const pay = pays[0] || {};
  const items = (b.bill_items || []).map(i => {
    const prod = Array.isArray(i.products) ? i.products[0] : i.products;
    return buildBillItem(i, prod && prod.product_name, prod && prod.barcode, prod && prod.cost_price);
  });
  return buildBillModel({
    bill_id: b.bill_id,
    bill_number: b.bill_number,
    bill_date: b.bill_date,
    customer_id: b.customer_id,
    customer_name: customer && customer.customer_name,
    customer_phone: customer && customer.phone,
    subtotal: b.subtotal,
    discount: b.discount,
    tax_amount: b.tax_amount,
    grand_total: b.grand_total,
    payment_method: b.payment_method,
    status: b.status,
    discount_type: b.discount_type,
    discount_value: b.discount_value,
    gst_rate: b.gst_rate,
    amount_tendered: pay.amount_tendered,
    change_due: pay.change_due,
    reference: pay.reference,
    items
  });
}

// JSON returned by create_sale / void_bill (public.get_bill_json)
function mapRpcBill(j) {
  const items = (j.items || []).map(i => buildBillItem(i, i.name, i.barcode, null));
  return buildBillModel({ ...j, items });
}

const CartKaroDB = {
  PAGE: 1000,
  _chain: Promise.resolve(),

  /** Every write requires a real staff session. A "Connected" badge is not enough. */
  async requireSession() {
    if (!SupabaseService.client) {
      throw new DbError('Supabase is not available (the library did not load). Check the internet connection and reload.', 'NO_CLIENT');
    }
    let result;
    try {
      result = await SupabaseService.client.auth.getSession();
    } catch (e) {
      throw wrapDbError(e);
    }
    const session = result && result.data && result.data.session;
    if (!session) {
      SupabaseService.isAuthenticated = false;
      SupabaseService.currentUser = null;
      SupabaseService.updateStatusBadge();
      throw new DbError('Please sign in with your staff account (click the Supabase badge at the top) before saving data.', 'AUTH_REQUIRED');
    }
    SupabaseService.isAuthenticated = true;
    SupabaseService.currentUser = session.user;
    return session;
  },

  /** Call a PostgreSQL function. Throws DbError with a readable message on any failure. */
  async rpc(name, args) {
    await this.requireSession();
    let res;
    try {
      res = await SupabaseService.client.rpc(name, args);
    } catch (e) {
      console.error(`[CartKaro] rpc ${name} threw:`, e);
      throw wrapDbError(e);
    }
    if (res.error) {
      console.error(`[CartKaro] rpc ${name} failed:`, res.error, args);
      throw wrapDbError(res.error);
    }
    return res.data;
  },

  async fetchAllPages(buildQuery, label) {
    let from = 0;
    let rows = [];
    for (;;) {
      const { data, error } = await buildQuery().range(from, from + this.PAGE - 1);
      if (error) {
        console.error(`[CartKaro] fetch ${label} failed:`, error);
        throw wrapDbError(error);
      }
      rows = rows.concat(data || []);
      if (!data || data.length < this.PAGE) break;
      from += this.PAGE;
    }
    return rows;
  },

  async fetchBills() {
    const rows = await this.fetchAllPages(() => SupabaseService.client
      .from('bills')
      .select('bill_id, bill_number, bill_date, customer_id, subtotal, discount, tax_amount, grand_total, payment_method, status, discount_type, discount_value, gst_rate, customers(customer_name, phone), bill_items(product_id, quantity, unit_price, discount, tax_amount, line_total, products(product_name, barcode, cost_price)), payments(payment_method, payment_status, amount, amount_tendered, change_due, reference)')
      .order('bill_date', { ascending: false })
      .order('bill_id', { ascending: false }), 'bills');
    return rows.map(mapBillRow);
  },

  async fetchMovements(products, bills) {
    const { data, error } = await SupabaseService.client
      .from('stock_transactions')
      .select('transaction_id, product_id, transaction_type, quantity_change, transaction_date, reference_id, products(product_name, barcode)')
      .order('transaction_date', { ascending: false })
      .order('transaction_id', { ascending: false })
      .limit(500);
    if (error) {
      console.error('[CartKaro] fetch stock_transactions failed:', error);
      throw wrapDbError(error);
    }

    // Walk backwards from today's stock so each row shows "previous -> new" stock.
    const running = new Map(products.map(p => [p.dbId, p.quantity]));
    const billNoById = new Map(bills.map(b => [String(b.billId), b.billNo]));

    return (data || []).map(t => {
      const prod = Array.isArray(t.products) ? t.products[0] : t.products;
      const change = toNum(t.quantity_change);
      let newStock = '—';
      let previousStock = '—';
      if (running.has(t.product_id)) {
        newStock = running.get(t.product_id);
        previousStock = round3(newStock - change);
        running.set(t.product_id, previousStock);
      }

      const ref = t.reference_id || '';
      let reason = ref;
      if (t.transaction_type === 'SALE') {
        reason = `Bill Sale Invoice #${billNoById.get(ref) || ('BILL-' + (1000 + Number(ref)))}`;
      } else if (ref.indexOf('VOID-') === 0) {
        reason = `Return/Void Restock for ${ref.slice(5)}`;
      }

      return {
        id: 'TX-' + t.transaction_id,
        date: new Date(t.transaction_date).toISOString(),
        productId: 'PRD-' + t.product_id,
        productName: (prod && prod.product_name) || ('Product #' + t.product_id),
        barcode: (prod && prod.barcode) || '',
        type: t.transaction_type === 'SALE' ? 'SALE' : (change > 0 ? 'STOCK_IN' : 'STOCK_OUT'),
        quantity: Math.abs(change),
        previousStock,
        newStock,
        reason
      };
    });
  },

  /**
   * Re-read products, inventory, bills and stock movements from Supabase,
   * replace the cache, and redraw the current view.
   * Resolves { ok: true } or { ok: false, error }. Never throws.
   */
  refreshAll() {
    const run = () => this._refreshOnce();
    this._chain = this._chain.then(run, run);
    return this._chain;
  },

  async _refreshOnce() {
    try {
      await this.requireSession();

      const prodRes = await SupabaseService.fetchProducts();
      if (prodRes.error) throw wrapDbError(prodRes.error);
      const products = prodRes.data || [];

      const bills = await this.fetchBills();
      const movements = await this.fetchMovements(products, bills);

      CartKaroStore.setProducts(products);
      CartKaroStore.setBills(bills);
      CartKaroStore.setMovements(movements);

      AppState.lastSync = new Date();
      AppState.syncError = null;
      this.updateStorageLabel();
      this.rerender();
      return { ok: true };
    } catch (err) {
      const e = wrapDbError(err);
      console.error('[CartKaro] refreshAll failed:', err);
      AppState.syncError = e.message;
      if (e.code === 'AUTH_REQUIRED') {
        CartKaroStore.clearData();
        this.rerender();
      }
      this.updateStorageLabel();
      return { ok: false, error: e };
    }
  },

  rerender() {
    try {
      renderView(AppState.currentView);
      updateStockAlertsBadge();
    } catch (e) {
      console.error('[CartKaro] re-render failed:', e);
    }
  },

  /** Footer label: shows where the data really comes from. */
  updateStorageLabel() {
    const el = document.querySelector('.app-footer span.fw-semibold');
    if (!el) return;
    if (AppState.syncError) {
      el.className = 'text-danger fw-semibold';
      el.innerHTML = '<i class="bi bi-exclamation-triangle me-1"></i>Supabase sync failed (see console)';
      el.title = AppState.syncError;
    } else if (AppState.lastSync) {
      el.className = 'text-success fw-semibold';
      el.innerHTML = '<i class="bi bi-database-check me-1"></i>Supabase PostgreSQL (live) &middot; synced ' +
        esc(AppState.lastSync.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      el.title = '';
    } else {
      el.className = 'text-warning fw-semibold';
      el.innerHTML = '<i class="bi bi-database-lock me-1"></i>Supabase PostgreSQL &middot; sign in to load data';
      el.title = '';
    }
  }
};

// Disable a button while an async action runs; returns a function that restores it.
function lockButton(btn, busyHtml) {
  if (!btn) return () => {};
  const original = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  if (busyHtml) btn.innerHTML = busyHtml;
  return () => {
    btn.innerHTML = original;
    btn.disabled = wasDisabled;
  };
}

const AppState = {
  currentView: 'dashboard',
  cart: [],
  cartBillNo: 'AUTO',
  lastSync: null,
  syncError: null,
  checkoutInFlight: false,
  checkoutAttempt: null,
  savingProduct: false,
  savingStock: false,
  voidingBill: false,
  editOrigQty: null,
  productsPage: 1,
  productsPerPage: 10,
  salesPage: 1,
  salesPerPage: 10,
  charts: {
    dashSales: null,
    dashPayment: null,
    repSales: null,
    repCategory: null
  }
};

const formatINR = num => '₹' + Number(num || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDateTime = dateStr => {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + 
         d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
};
const formatDateOnly = dateStr => new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

function showToast(message, isError = false) {
  const toastEl = document.getElementById('live-toast');
  const toastBody = document.getElementById('toast-message');
  if (!toastEl || !toastBody) return;
  toastBody.innerHTML = `<i class="bi ${isError ? 'bi-exclamation-circle text-warning' : 'bi-check-circle text-success'} fs-5"></i> <span>${message}</span>`;
  toastEl.className = `toast align-items-center text-white ${isError ? 'bg-danger' : 'bg-dark'} border-0 shadow`;
  const bsToast = bootstrap.Toast.getOrCreateInstance(toastEl);
  bsToast.show();
}

function openConfirmModal({ title, message, iconClass = 'bi-exclamation-triangle', onConfirm }) {
  const modalEl = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title || 'Are you sure?';
  document.getElementById('confirm-message').textContent = message || 'This action cannot be undone.';
  document.getElementById('confirm-icon').innerHTML = `<i class="bi ${iconClass}"></i>`;
  const confirmBtn = document.getElementById('confirm-action-btn');
  
  // Clone button to clear previous listeners
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  
  const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);
  newBtn.addEventListener('click', () => {
    bsModal.hide();
    if (typeof onConfirm === 'function') onConfirm();
  });
  bsModal.show();
}

// Generate Next Bill Number
function getNextBillNumber() {
  // The real bill number (BILL-1013 style) is assigned by the database when the sale is saved.
  return 'AUTO';
}

// ==========================================================================
// 4. NAVIGATION & SIDEBAR CONTROLLER
// ==========================================================================
function switchView(viewName) {
  AppState.currentView = viewName;
  
  // Update view containers
  document.querySelectorAll('.app-view').forEach(el => el.classList.add('d-none'));
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.classList.remove('d-none');

  // Update sidebar active links
  document.querySelectorAll('.sidebar .nav-link').forEach(link => {
    if (link.dataset.target === viewName) {
      link.classList.add('active');
      link.classList.remove('text-secondary');
    } else {
      link.classList.remove('active');
      link.classList.add('text-secondary');
    }
  });

  // Update topbar breadcrumbs
  const titles = {
    dashboard: ['Dashboard', 'Overview & store statistics'],
    products: ['Product Management', 'Catalog, pricing, and stock controls'],
    inventory: ['Inventory & Stock Audit', 'Real-time stock valuation & logs'],
    scanner: ['Barcode Scanner', 'Hardware & manual barcode terminal'],
    pos: ['Point-of-Sale Billing', 'Fast checkout & receipt printing'],
    sales: ['Sales History', 'Customer invoices & past transactions'],
    reports: ['Reports & Analytics', 'Business intelligence & trends'],
    settings: ['Store Settings', 'Shop profile, GST, and backup']
  };

  const pageTitleEl = document.getElementById('page-title');
  const pageSubtitleEl = document.getElementById('page-subtitle');
  if (pageTitleEl && titles[viewName]) {
    pageTitleEl.textContent = titles[viewName][0];
    pageSubtitleEl.textContent = titles[viewName][1];
  }

  // Close mobile sidebar if open
  document.body.classList.remove('sidebar-mobile-open');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (backdrop) backdrop.classList.add('d-none');

  // Trigger view renderers
  renderView(viewName);
}

function renderView(viewName) {
  switch (viewName) {
    case 'dashboard':
      renderDashboard();
      break;
    case 'products':
      renderProducts();
      break;
    case 'inventory':
      renderInventory();
      break;
    case 'scanner':
      renderScanner();
      break;
    case 'pos':
      renderPOS();
      break;
    case 'sales':
      renderSales();
      break;
    case 'reports':
      renderReports();
      break;
    case 'settings':
      renderSettings();
      break;
  }
}

// Clock & Live Alerts Update
function startClockAndHeartbeat() {
  function updateTime() {
    const now = new Date();
    const clockEl = document.getElementById('live-clock');
    if (clockEl) {
      clockEl.textContent = now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }) + ' • ' + 
                            now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    }
  }
  updateTime();
  setInterval(updateTime, 1000);
}

function updateStockAlertsBadge() {
  const products = CartKaroStore.getProducts();
  const settings = CartKaroStore.getSettings();
  const threshold = settings.lowStockThreshold || 10;
  
  const lowItems = products.filter(p => p.quantity > 0 && p.quantity <= (p.minStock || threshold));
  const outItems = products.filter(p => p.quantity <= 0);
  const totalAlerts = lowItems.length + outItems.length;

  // Sidebar badge
  const sidebarBadge = document.getElementById('low-stock-sidebar-badge');
  if (sidebarBadge) {
    if (totalAlerts > 0) {
      sidebarBadge.textContent = totalAlerts;
      sidebarBadge.classList.remove('d-none');
    } else {
      sidebarBadge.classList.add('d-none');
    }
  }

  // Topbar notification bell badge
  const notifBadge = document.getElementById('notif-badge');
  const notifCountBadge = document.getElementById('notif-count-badge');
  const notifList = document.getElementById('notif-list');

  if (notifBadge) {
    if (totalAlerts > 0) {
      notifBadge.classList.remove('d-none');
    } else {
      notifBadge.classList.add('d-none');
    }
  }

  if (notifCountBadge) notifCountBadge.textContent = `${totalAlerts} alerts`;

  if (notifList) {
    if (totalAlerts === 0) {
      notifList.innerHTML = '<div class="text-center p-4 text-muted small"><i class="bi bi-check-circle text-success fs-4 d-block mb-1"></i>All stock levels healthy!</div>';
    } else {
      let html = '';
      outItems.forEach(p => {
        html += `
          <div class="list-group-item list-group-item-action p-2 border-bottom">
            <div class="d-flex align-items-center justify-content-between">
              <strong class="text-danger small text-truncate" style="max-width: 190px;">${p.name}</strong>
              <span class="badge bg-danger">OUT OF STOCK</span>
            </div>
            <small class="text-muted d-block font-monospace">${p.barcode}</small>
          </div>
        `;
      });
      lowItems.forEach(p => {
        html += `
          <div class="list-group-item list-group-item-action p-2 border-bottom">
            <div class="d-flex align-items-center justify-content-between">
              <strong class="text-dark small text-truncate" style="max-width: 190px;">${p.name}</strong>
              <span class="badge bg-warning text-dark">Stock: ${p.quantity} (Min ${p.minStock || threshold})</span>
            </div>
            <small class="text-muted d-block font-monospace">${p.barcode}</small>
          </div>
        `;
      });
      notifList.innerHTML = html;
    }
  }
}

// ==========================================================================
// 5. DASHBOARD VIEW CONTROLLER & CHARTS
// ==========================================================================
function renderDashboard() {
  const products = CartKaroStore.getProducts();
  const bills = CartKaroStore.getBills();
  const settings = CartKaroStore.getSettings();
  const threshold = settings.lowStockThreshold || 10;

  // Calculate KPIs
  const totalProducts = products.length;
  
  // Today's Sales
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayBills = bills.filter(b => b.status === 'Completed' && b.date.slice(0, 10) === todayStr);
  const todaySales = todayBills.reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);

  // Low & Out of stock counts
  const lowStockCount = products.filter(p => p.quantity > 0 && p.quantity <= (p.minStock || threshold)).length;
  const outOfStockCount = products.filter(p => p.quantity <= 0).length;

  // Total bills & All-time revenue
  const completedBills = bills.filter(b => b.status === 'Completed');
  const totalBillsCount = completedBills.length;
  const totalRevenue = completedBills.reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);

  // Total Inventory Valuation (Cost value)
  const inventoryCostValuation = products.reduce((sum, p) => sum + (Number(p.quantity || 0) * Number(p.costPrice || 0)), 0);

  // Update KPI Elements
  document.getElementById('stat-total-products').textContent = totalProducts;
  document.getElementById('stat-today-sales').textContent = formatINR(todaySales);
  document.getElementById('stat-today-bills-count').textContent = `${todayBills.length} invoice(s) today`;
  document.getElementById('stat-low-stock').textContent = lowStockCount;
  document.getElementById('stat-out-of-stock').textContent = `${outOfStockCount} out of stock`;
  document.getElementById('stat-total-bills').textContent = totalBillsCount;
  document.getElementById('stat-inventory-value').textContent = formatINR(inventoryCostValuation);
  document.getElementById('stat-total-revenue').textContent = formatINR(totalRevenue);

  // Render Charts
  renderDashboardSalesChart('daily');
  renderDashboardPaymentChart();

  // Render Best Sellers Table
  renderDashboardBestSellers();

  // Render Low Stock Table
  renderDashboardLowStock();

  // Render Recent Invoices
  renderDashboardRecentBills();

  updateStockAlertsBadge();
}

function renderDashboardSalesChart(period = 'daily') {
  const canvas = document.getElementById('dashboard-sales-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');

  let labels = [];
  let dataPoints = [];

  const now = new Date();

  if (period === 'daily') {
    // Last 7 Days
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const dStr = d.toISOString().slice(0, 10);
      const dayLabel = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' });
      labels.push(dayLabel);
      const dayTotal = bills
        .filter(b => b.date.slice(0, 10) === dStr)
        .reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
      dataPoints.push(dayTotal);
    }
  } else if (period === 'weekly') {
    // Last 4 Weeks
    for (let w = 3; w >= 0; w--) {
      labels.push(`Week ${4 - w}`);
      const start = new Date(now.getTime() - (w + 1) * 7 * 86400000);
      const end = new Date(now.getTime() - w * 7 * 86400000);
      const weekTotal = bills
        .filter(b => {
          const bd = new Date(b.date);
          return bd >= start && bd < end;
        })
        .reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
      dataPoints.push(weekTotal);
    }
  } else if (period === 'monthly') {
    // Last 6 Months
    for (let m = 5; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const monthLabel = d.toLocaleDateString('en-IN', { month: 'short' });
      labels.push(monthLabel);
      const mYear = d.getFullYear();
      const mMonth = d.getMonth();
      const monthTotal = bills
        .filter(b => {
          const bd = new Date(b.date);
          return bd.getFullYear() === mYear && bd.getMonth() === mMonth;
        })
        .reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
      dataPoints.push(monthTotal);
    }
  }

  if (AppState.charts.dashSales) {
    AppState.charts.dashSales.destroy();
  }

  AppState.charts.dashSales = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Revenue (₹)',
          data: dataPoints,
          backgroundColor: 'rgba(30, 64, 175, 0.85)',
          hoverBackgroundColor: '#1d4ed8',
          borderRadius: 6,
          barPercentage: 0.55
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => ` Revenue: ${formatINR(context.raw)}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: val => '₹' + val
          },
          grid: { color: '#f1f5f9' }
        },
        x: {
          grid: { display: false }
        }
      }
    }
  });
}

function renderDashboardPaymentChart() {
  const canvas = document.getElementById('dashboard-payment-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');

  let cashTotal = 0, upiTotal = 0, cardTotal = 0;
  bills.forEach(b => {
    const amt = Number(b.grandTotal || 0);
    if (b.paymentMethod === 'Cash') cashTotal += amt;
    else if (b.paymentMethod === 'UPI') upiTotal += amt;
    else if (b.paymentMethod === 'Card') cardTotal += amt;
  });

  if (AppState.charts.dashPayment) {
    AppState.charts.dashPayment.destroy();
  }

  AppState.charts.dashPayment = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Cash', 'UPI / QR', 'Card'],
      datasets: [{
        data: [cashTotal, upiTotal, cardTotal],
        backgroundColor: ['#10b981', '#3b82f6', '#8b5cf6'],
        borderWidth: 2,
        borderColor: '#ffffff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => ` ${context.label}: ${formatINR(context.raw)}`
          }
        }
      },
      cutout: '68%'
    }
  });

  // Render HTML Legend
  const legendEl = document.getElementById('dash-payment-legend');
  if (legendEl) {
    legendEl.innerHTML = `
      <div><span class="badge bg-success me-1">●</span> Cash: <strong>${formatINR(cashTotal)}</strong></div>
      <div><span class="badge bg-primary me-1">●</span> UPI: <strong>${formatINR(upiTotal)}</strong></div>
      <div><span class="badge bg-purple-subtle text-purple me-1">●</span> Card: <strong>${formatINR(cardTotal)}</strong></div>
    `;
  }
}

function renderDashboardBestSellers() {
  const tbody = document.getElementById('dash-bestsellers-tbody');
  if (!tbody) return;
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');

  const salesMap = {};
  bills.forEach(b => {
    (b.items || []).forEach(item => {
      if (!salesMap[item.productId]) {
        salesMap[item.productId] = { name: item.name, units: 0, revenue: 0 };
      }
      salesMap[item.productId].units += Number(item.quantity || 0);
      salesMap[item.productId].revenue += Number(item.amount || (item.rate * item.quantity));
    });
  });

  const sorted = Object.values(salesMap).sort((a, b) => b.units - a.units).slice(0, 5);
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">No sales registered yet</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map((p, index) => `
    <tr>
      <td class="fw-bold text-muted">${index + 1}</td>
      <td class="text-truncate fw-semibold" style="max-width: 140px;">${p.name}</td>
      <td class="text-center"><span class="badge bg-primary-subtle text-primary">${p.units} pcs</span></td>
      <td class="text-end fw-bold text-dark">${formatINR(p.revenue)}</td>
    </tr>
  `).join('');
}

function renderDashboardLowStock() {
  const tbody = document.getElementById('dash-lowstock-tbody');
  if (!tbody) return;
  const products = CartKaroStore.getProducts();
  const settings = CartKaroStore.getSettings();
  const threshold = settings.lowStockThreshold || 10;

  const lowItems = products
    .filter(p => p.quantity <= (p.minStock || threshold))
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 5);

  if (lowItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-success py-3"><i class="bi bi-check-circle me-1"></i>All stocks healthy</td></tr>';
    return;
  }

  tbody.innerHTML = lowItems.map(p => {
    const isOut = p.quantity <= 0;
    return `
      <tr>
        <td class="text-truncate fw-semibold" style="max-width: 140px;" title="${p.name}">${p.name}</td>
        <td><strong class="${isOut ? 'text-danger' : 'text-warning'}">${p.quantity} Units</strong></td>
        <td>
          <span class="badge ${isOut ? 'bg-danger' : 'bg-warning text-dark'}">
            ${isOut ? 'Out of Stock' : 'Low Stock'}
          </span>
        </td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary py-0 px-2 quick-restock-btn" data-id="${p.id}" title="Restock">
            <i class="bi bi-plus-lg"></i> In
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderDashboardRecentBills() {
  const tbody = document.getElementById('dash-recent-bills-tbody');
  if (!tbody) return;
  const bills = CartKaroStore.getBills().slice(0, 5);

  if (bills.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">No bills generated yet</td></tr>';
    return;
  }

  tbody.innerHTML = bills.map(b => `
    <tr>
      <td class="font-monospace fw-semibold">${b.billNo}</td>
      <td class="text-truncate" style="max-width: 100px;">${b.customerName || 'Walk-in'}</td>
      <td class="text-end fw-bold text-dark">${formatINR(b.grandTotal)}</td>
      <td class="text-center">
        <button class="btn btn-sm btn-link p-0 text-primary view-rcpt-btn" data-bill="${b.billNo}">
          <i class="bi bi-eye"></i>
        </button>
      </td>
    </tr>
  `).join('');
}

// ==========================================================================
// 6. PRODUCT MANAGEMENT CONTROLLER
// ==========================================================================
function renderProducts() {
  const products = CartKaroStore.getProducts();
  const search = (document.getElementById('prod-search-input')?.value || '').toLowerCase().trim();
  const catFilter = document.getElementById('prod-category-filter')?.value || '';
  const statusFilter = document.getElementById('prod-status-filter')?.value || '';
  const sortFilter = document.getElementById('prod-sort-filter')?.value || 'name-asc';
  const settings = CartKaroStore.getSettings();
  const threshold = settings.lowStockThreshold || 10;

  // Update Live Supabase Status Alert Banner
  const alertEl = document.getElementById('supabase-products-alert');
  const alertTitle = document.getElementById('supabase-products-alert-title');
  const alertText = document.getElementById('supabase-products-alert-text');
  if (alertEl && alertTitle && alertText) {
    alertEl.classList.remove('d-none');
    if (SupabaseService.isAuthenticated && SupabaseService.currentUser) {
      alertEl.className = 'alert alert-success py-2 px-3 mt-3 mb-0 d-flex align-items-center justify-content-between small';
      alertTitle.textContent = 'Supabase Authenticated:';
      alertText.textContent = ` Logged in as ${SupabaseService.currentUser.email}. Live database products active.`;
    } else if (SupabaseService.lastRlsStatus === 'restricted') {
      alertEl.className = 'alert alert-warning py-2 px-3 mt-3 mb-0 d-flex align-items-center justify-content-between small';
      alertTitle.textContent = 'Supabase RLS Active:';
      alertText.textContent = ' Row Level Security restricts guest reads (0 rows returned). Displaying local fallback data. Log in as staff to view database records.';
    } else if (SupabaseService.isConnected) {
      alertEl.className = 'alert alert-info py-2 px-3 mt-3 mb-0 d-flex align-items-center justify-content-between small';
      alertTitle.textContent = 'Supabase Connected:';
      alertText.textContent = ' Endpoint ywobsbogfesnvsgqbhej.supabase.co is active.';
    } else {
      alertEl.classList.add('d-none');
    }
  }

  // Populate Category Filter dropdown if empty
  const catSelect = document.getElementById('prod-category-filter');
  if (catSelect && catSelect.children.length <= 1) {
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
    cats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
  }

  // Filter
  let filtered = products.filter(p => {
    const matchSearch = !search || 
      p.name.toLowerCase().includes(search) || 
      p.id.toLowerCase().includes(search) || 
      p.barcode.toLowerCase().includes(search) ||
      (p.supplier && p.supplier.toLowerCase().includes(search));
    
    const matchCat = !catFilter || p.category === catFilter;

    let matchStatus = true;
    if (statusFilter === 'in-stock') matchStatus = p.quantity > (p.minStock || threshold);
    else if (statusFilter === 'low-stock') matchStatus = p.quantity > 0 && p.quantity <= (p.minStock || threshold);
    else if (statusFilter === 'out-of-stock') matchStatus = p.quantity <= 0;

    return matchSearch && matchCat && matchStatus;
  });

  // Sort
  filtered.sort((a, b) => {
    switch (sortFilter) {
      case 'name-asc': return a.name.localeCompare(b.name);
      case 'name-desc': return b.name.localeCompare(a.name);
      case 'price-asc': return a.sellingPrice - b.sellingPrice;
      case 'price-desc': return b.sellingPrice - a.sellingPrice;
      case 'stock-asc': return a.quantity - b.quantity;
      case 'stock-desc': return b.quantity - a.quantity;
      case 'expiry-asc': return (a.expiryDate || '9999').localeCompare(b.expiryDate || '9999');
      default: return 0;
    }
  });

  // Pagination
  const total = filtered.length;
  const perPage = AppState.productsPerPage;
  const totalPages = Math.ceil(total / perPage) || 1;
  if (AppState.productsPage > totalPages) AppState.productsPage = totalPages;
  const start = (AppState.productsPage - 1) * perPage;
  const paged = filtered.slice(start, start + perPage);

  const tbody = document.getElementById('products-tbody');
  const emptyState = document.getElementById('products-empty');
  const countInfo = document.getElementById('products-count-info');

  if (countInfo) {
    countInfo.textContent = total > 0 
      ? `Showing ${start + 1} to ${Math.min(start + perPage, total)} of ${total} products`
      : 'Showing 0 products';
  }

  if (total === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('d-none');
    renderProductsPagination(0, 1);
    return;
  }

  emptyState.classList.add('d-none');
  tbody.innerHTML = paged.map(p => {
    const isOut = p.quantity <= 0;
    const isLow = !isOut && p.quantity <= (p.minStock || threshold);
    const badgeClass = isOut ? 'bg-danger' : isLow ? 'bg-warning text-dark' : 'bg-success-subtle text-success border border-success-subtle';
    const statusText = isOut ? 'Out of Stock' : isLow ? 'Low Stock' : 'In Stock';

    return `
      <tr>
        <td class="ps-3">
          <strong class="text-primary font-monospace">${p.id}</strong>
          <small class="text-muted d-block font-monospace"><i class="bi bi-upc me-1"></i>${p.barcode}</small>
        </td>
        <td>
          <div class="fw-semibold text-dark">${p.name}</div>
        </td>
        <td>
          <span class="badge bg-light text-secondary border">${p.category}</span>
        </td>
        <td class="text-end text-muted font-monospace">${formatINR(p.costPrice)}</td>
        <td class="text-end fw-bold text-dark font-monospace">${formatINR(p.sellingPrice)}</td>
        <td class="text-center">
          <span class="badge ${badgeClass} px-2 py-1">${p.quantity} Units</span>
        </td>
        <td class="text-muted small">${p.minStock || threshold} Units</td>
        <td class="small text-truncate" style="max-width: 110px;" title="${p.supplier || '--'}">${p.supplier || '--'}</td>
        <td class="small ${p.expiryDate && new Date(p.expiryDate) < new Date() ? 'text-danger fw-bold' : 'text-muted'}">
          ${p.expiryDate ? formatDateOnly(p.expiryDate) : '--'}
        </td>
        <td class="text-end pe-3">
          <div class="btn-group btn-group-sm">
            <button class="btn btn-light border edit-prod-btn" data-id="${p.id}" title="Edit Product">
              <i class="bi bi-pencil text-primary"></i>
            </button>
            <button class="btn btn-light border del-prod-btn" data-id="${p.id}" title="Delete Product">
              <i class="bi bi-trash3 text-danger"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderProductsPagination(totalPages, AppState.productsPage);
}

function renderProductsPagination(totalPages, currentPage) {
  const container = document.getElementById('products-pagination');
  if (!container) return;
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
      <button class="page-link" data-page="${currentPage - 1}">&laquo;</button>
    </li>
  `;

  for (let i = 1; i <= totalPages; i++) {
    html += `
      <li class="page-item ${i === currentPage ? 'active' : ''}">
        <button class="page-link" data-page="${i}">${i}</button>
      </li>
    `;
  }

  html += `
    <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
      <button class="page-link" data-page="${currentPage + 1}">&raquo;</button>
    </li>
  `;

  container.innerHTML = html;
}

// Product Form Modal Handlers
function openProductModal(mode = 'add', prodId = null) {
  const form = document.getElementById('product-form');
  form.reset();
  form.classList.remove('was-validated');
  document.getElementById('prod-form-mode').value = mode;

  const titleEl = document.getElementById('productModalLabel');
  const idInput = document.getElementById('prod-id');
  const barcodeInput = document.getElementById('prod-barcode');
  AppState.editOrigQty = null;

  if (mode === 'add') {
    titleEl.innerHTML = '<i class="bi bi-plus-circle me-2"></i>Add New Product';
    // The database assigns the real product ID (PRD-<number>) when the product is saved.
    idInput.value = 'PRD-AUTO';
    idInput.setAttribute('readonly', 'true');
    barcodeInput.value = '890103' + Math.floor(1000000 + Math.random() * 9000000);
    document.getElementById('prod-min-stock').value = 10;
  } else {
    titleEl.innerHTML = '<i class="bi bi-pencil me-2"></i>Edit Product';
    const product = CartKaroStore.getProducts().find(p => p.id === prodId);
    if (!product) return;

    idInput.value = product.id;
    idInput.setAttribute('readonly', 'true');
    barcodeInput.value = product.barcode;
    document.getElementById('prod-name').value = product.name;
    document.getElementById('prod-category').value = product.category;
    document.getElementById('prod-cost').value = product.costPrice;
    document.getElementById('prod-price').value = product.sellingPrice;
    document.getElementById('prod-qty').value = product.quantity;
    document.getElementById('prod-min-stock').value = product.minStock || 10;
    document.getElementById('prod-supplier').value = product.supplier || '';
    document.getElementById('prod-expiry').value = product.expiryDate || '';
    // Remember the stock shown, so saving other fields never overwrites newer stock.
    AppState.editOrigQty = product.quantity;
  }

  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('product-modal'));
  modal.show();
}

async function handleProductFormSubmit(e) {
  e.preventDefault();
  if (AppState.savingProduct) return;

  const form = document.getElementById('product-form');
  if (!form.checkValidity()) {
    form.classList.add('was-validated');
    SoundFx.alertTone();
    return;
  }

  const mode = document.getElementById('prod-form-mode').value;
  const id = document.getElementById('prod-id').value.trim();
  const barcode = document.getElementById('prod-barcode').value.trim();
  const name = document.getElementById('prod-name').value.trim();
  const category = document.getElementById('prod-category').value.trim();
  const costPrice = parseFloat(document.getElementById('prod-cost').value);
  const sellingPrice = parseFloat(document.getElementById('prod-price').value);
  const quantity = parseInt(document.getElementById('prod-qty').value, 10);
  const minStock = parseInt(document.getElementById('prod-min-stock').value, 10) || 10;
  const supplier = document.getElementById('prod-supplier').value.trim();
  const expiryDate = document.getElementById('prod-expiry').value;

  const products = CartKaroStore.getProducts();
  let existing = null;

  if (mode === 'edit') {
    existing = products.find(p => p.id === id);
    if (!existing) {
      showToast('This product no longer exists. Refresh the data and try again.', true);
      SoundFx.alertTone();
      return;
    }
  }

  // Quick duplicate-barcode check (the database enforces it too)
  if (products.some(p => (!existing || p.id !== existing.id) && p.barcode === barcode)) {
    showToast(`Barcode "${barcode}" is already registered to another product!`, true);
    SoundFx.alertTone();
    return;
  }

  const settings = CartKaroStore.getSettings();
  const submitBtn = document.querySelector('#product-modal button[type="submit"]');
  const unlock = lockButton(submitBtn, '<span class="spinner-border spinner-border-sm me-2"></span>Saving...');
  AppState.savingProduct = true;

  try {
    // For an edit, send the stock count only if the user actually changed it.
    const qtyArg = mode === 'add'
      ? quantity
      : (quantity !== AppState.editOrigQty ? quantity : null);

    await CartKaroDB.rpc('save_product', {
      p_product_id: existing ? existing.dbId : null,
      p_name: name,
      p_barcode: barcode,
      p_category: category,
      p_price: sellingPrice,
      p_tax_rate: existing ? existing.taxRate : (settings.defaultGst || 0),
      p_unit: existing ? existing.unit : 'pack',
      p_cost_price: costPrice,
      p_supplier: supplier || null,
      p_expiry: expiryDate || null,
      p_quantity: qtyArg,
      p_reorder_level: minStock
    });

    bootstrap.Modal.getInstance(document.getElementById('product-modal')).hide();
    const sync = await CartKaroDB.refreshAll();
    if (mode === 'add') {
      showToast(`Product "${name}" added successfully!`);
      SoundFx.successChime();
    } else {
      showToast(`Product "${name}" updated successfully!`);
      SoundFx.beep(900, 0.1);
    }
    if (!sync.ok) showToast(`Saved, but the list could not be refreshed: ${sync.error.message}`, true);
  } catch (err) {
    const e = wrapDbError(err);
    console.error('[CartKaro] save product failed:', err);
    showToast(`Product was NOT saved: ${e.message}`, true);
    SoundFx.alertTone();
  } finally {
    AppState.savingProduct = false;
    unlock();
  }
}

function deleteProduct(prodId) {
  const products = CartKaroStore.getProducts();
  const product = products.find(p => p.id === prodId);
  if (!product) return;

  openConfirmModal({
    title: 'Delete Product?',
    message: `Are you sure you want to delete "${product.name}" (${product.id})? Products that already appear on bills are archived instead, so old bills stay intact.`,
    onConfirm: async () => {
      try {
        const res = await CartKaroDB.rpc('delete_product', { p_product_id: product.dbId });
        const sync = await CartKaroDB.refreshAll();
        if (res && res.mode === 'archived') {
          showToast(`"${product.name}" has sales history, so it was archived (hidden) instead of deleted.`);
        } else {
          showToast(`Product "${product.name}" deleted.`);
        }
        if (!sync.ok) showToast(`Deleted, but the list could not be refreshed: ${sync.error.message}`, true);
      } catch (err) {
        const e = wrapDbError(err);
        console.error('[CartKaro] delete product failed:', err);
        showToast(`Product was NOT deleted: ${e.message}`, true);
        SoundFx.alertTone();
      }
    }
  });
}

// ==========================================================================
// 7. INVENTORY MANAGEMENT CONTROLLER
// ==========================================================================
function renderInventory() {
  const products = CartKaroStore.getProducts();
  const movements = CartKaroStore.getMovements();
  const settings = CartKaroStore.getSettings();
  const threshold = settings.lowStockThreshold || 10;

  // Valuation metrics
  const totalUnits = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
  const costValuation = products.reduce((sum, p) => sum + (Number(p.quantity || 0) * Number(p.costPrice || 0)), 0);
  const retailValuation = products.reduce((sum, p) => sum + (Number(p.quantity || 0) * Number(p.sellingPrice || 0)), 0);
  const estProfit = retailValuation - costValuation;

  document.getElementById('inv-total-units').textContent = `${totalUnits.toLocaleString('en-IN')} Units`;
  document.getElementById('inv-cost-value').textContent = formatINR(costValuation);
  document.getElementById('inv-retail-value').textContent = `${formatINR(retailValuation)} (Est. ${formatINR(estProfit)})`;

  // Populate Categories Filter
  const catSelect = document.getElementById('inv-category-filter');
  if (catSelect && catSelect.children.length <= 1) {
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
    cats.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
  }

  // Filter Table 1: Stock Levels
  const search = (document.getElementById('inv-search-input')?.value || '').toLowerCase().trim();
  const catFilter = document.getElementById('inv-category-filter')?.value || '';
  const statusFilter = document.getElementById('inv-status-filter')?.value || '';

  const filtered = products.filter(p => {
    const matchSearch = !search || 
      p.name.toLowerCase().includes(search) || 
      p.barcode.includes(search) || 
      p.category.toLowerCase().includes(search);
    const matchCat = !catFilter || p.category === catFilter;

    let matchStatus = true;
    if (statusFilter === 'in-stock') matchStatus = p.quantity > (p.minStock || threshold);
    else if (statusFilter === 'low-stock') matchStatus = p.quantity > 0 && p.quantity <= (p.minStock || threshold);
    else if (statusFilter === 'out-of-stock') matchStatus = p.quantity <= 0;

    return matchSearch && matchCat && matchStatus;
  });

  const tbody = document.getElementById('inventory-tbody');
  tbody.innerHTML = filtered.map(p => {
    const isOut = p.quantity <= 0;
    const isLow = !isOut && p.quantity <= (p.minStock || threshold);
    const badgeClass = isOut ? 'bg-danger' : isLow ? 'bg-warning text-dark' : 'bg-success-subtle text-success border border-success-subtle';
    const statusText = isOut ? 'Out of Stock' : isLow ? 'Low Stock Alert' : 'In Stock';
    const costVal = p.quantity * p.costPrice;
    const retailVal = p.quantity * p.sellingPrice;

    return `
      <tr>
        <td class="font-monospace text-muted"><i class="bi bi-upc me-1"></i>${p.barcode}</td>
        <td class="fw-semibold text-dark">${p.name}</td>
        <td><span class="badge bg-light text-secondary border">${p.category}</span></td>
        <td class="text-center">
          <span class="badge ${badgeClass} fs-6 px-3 py-1">${p.quantity}</span>
        </td>
        <td class="text-center text-muted small">${p.minStock || threshold}</td>
        <td><span class="badge ${badgeClass}">${statusText}</span></td>
        <td class="text-end text-muted font-monospace">${formatINR(costVal)}</td>
        <td class="text-end fw-bold text-dark font-monospace">${formatINR(retailVal)}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary quick-stock-adjust-btn" data-id="${p.id}">
            <i class="bi bi-arrow-left-right me-1"></i> Adjust
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Render Table 2: Movement Logs
  renderMovementAuditTable();
}

function renderMovementAuditTable() {
  const movSearch = (document.getElementById('movement-search-input')?.value || '').toLowerCase().trim();
  const movements = CartKaroStore.getMovements();

  const filtered = movements.filter(m => {
    return !movSearch || 
      m.productName.toLowerCase().includes(movSearch) || 
      (m.barcode && m.barcode.includes(movSearch)) || 
      (m.reason && m.reason.toLowerCase().includes(movSearch));
  });

  const tbody = document.getElementById('movements-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">No movement history logs found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.slice(0, 50).map(m => {
    const isAdd = m.type === 'STOCK_IN';
    const badgeBg = isAdd ? 'bg-success-subtle text-success border border-success-subtle' : 
                    m.type === 'SALE' ? 'bg-primary-subtle text-primary border border-primary-subtle' : 'bg-warning-subtle text-warning border border-warning-subtle';
    const typeLabel = isAdd ? 'Stock In (+)' : m.type === 'SALE' ? 'POS Sale (-)' : 'Stock Out / Audit (-)';

    return `
      <tr>
        <td class="small text-muted font-monospace">${formatDateTime(m.date)}</td>
        <td>
          <div class="fw-semibold">${m.productName}</div>
          <small class="text-muted font-monospace">${m.barcode || ''}</small>
        </td>
        <td><span class="badge ${badgeBg}">${typeLabel}</span></td>
        <td class="text-center fw-bold ${isAdd ? 'text-success' : 'text-danger'}">
          ${isAdd ? '+' : '-'}${m.quantity}
        </td>
        <td class="text-center font-monospace small">
          <span class="text-muted">${m.previousStock}</span> &rarr; <strong class="text-dark">${m.newStock}</strong>
        </td>
        <td class="small text-muted">${m.reason || '--'}</td>
      </tr>
    `;
  }).join('');
}

// Stock Adjustment Modal Handler
function openStockModal(targetProductId = null, opType = 'IN') {
  const products = CartKaroStore.getProducts();
  const selectEl = document.getElementById('stock-product-select');
  selectEl.innerHTML = products.map(p => `
    <option value="${p.id}" ${p.id === targetProductId ? 'selected' : ''}>
      ${p.name} (Stock: ${p.quantity}) - [${p.barcode}]
    </option>
  `).join('');

  if (opType === 'IN') document.getElementById('stock-op-in').checked = true;
  else if (opType === 'OUT') document.getElementById('stock-op-out').checked = true;

  updateStockModalPreview();
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('stock-modal'));
  modal.show();
}

function updateStockModalPreview() {
  const products = CartKaroStore.getProducts();
  const prodId = document.getElementById('stock-product-select').value;
  const product = products.find(p => p.id === prodId);
  if (!product) return;

  const currentDisplay = document.getElementById('stock-current-display');
  const projectedDisplay = document.getElementById('stock-projected-display');
  const qtyInput = document.getElementById('stock-qty-input');
  const qty = parseInt(qtyInput.value, 10) || 0;

  const opType = document.querySelector('input[name="stockOpType"]:checked')?.value || 'IN';

  currentDisplay.textContent = `${product.quantity} Units`;

  let newQty = product.quantity;
  if (opType === 'IN') newQty += qty;
  else if (opType === 'OUT') newQty = Math.max(0, newQty - qty);
  else if (opType === 'ADJUST') newQty = qty;

  projectedDisplay.textContent = `${newQty} Units`;
}

async function handleStockFormSubmit(e) {
  e.preventDefault();
  if (AppState.savingStock) return;

  const products = CartKaroStore.getProducts();
  const prodId = document.getElementById('stock-product-select').value;
  const product = products.find(p => p.id === prodId);
  if (!product) {
    showToast('Select a product first.', true);
    return;
  }

  const opType = document.querySelector('input[name="stockOpType"]:checked').value;
  const qty = parseInt(document.getElementById('stock-qty-input').value, 10) || 0;
  const reasonSelect = document.getElementById('stock-reason-select').value;
  const customNote = document.getElementById('stock-custom-note').value.trim();
  const fullReason = customNote ? `${reasonSelect}: ${customNote}` : reasonSelect;

  if (qty <= 0 && opType !== 'ADJUST') {
    showToast('Adjustment quantity must be greater than 0', true);
    SoundFx.alertTone();
    return;
  }
  if (opType === 'OUT' && qty > product.quantity) {
    showToast(`Cannot deduct ${qty} units! Current stock is only ${product.quantity}.`, true);
    SoundFx.alertTone();
    return;
  }

  const submitBtn = document.querySelector('#stock-modal button[type="submit"]');
  const unlock = lockButton(submitBtn, '<span class="spinner-border spinner-border-sm me-2"></span>Saving...');
  AppState.savingStock = true;

  try {
    const result = await CartKaroDB.rpc('adjust_stock', {
      p_product_id: product.dbId,
      p_op: opType === 'ADJUST' ? 'SET' : opType,
      p_quantity: qty,
      p_reason: fullReason
    });

    bootstrap.Modal.getInstance(document.getElementById('stock-modal')).hide();
    const sync = await CartKaroDB.refreshAll();
    showToast(`Inventory updated for "${product.name}". New Stock: ${toNum(result.new_stock)} units`);
    SoundFx.successChime();
    if (!sync.ok) showToast(`Saved, but the list could not be refreshed: ${sync.error.message}`, true);
  } catch (err) {
    const e = wrapDbError(err);
    console.error('[CartKaro] stock adjustment failed:', err);
    showToast(`Stock was NOT changed: ${e.message}`, true);
    SoundFx.alertTone();
    // Stock may have changed elsewhere (e.g. another till): show the real numbers.
    CartKaroDB.refreshAll();
  } finally {
    AppState.savingStock = false;
    unlock();
  }
}

// ==========================================================================
// 8. BARCODE SCANNER VIEW CONTROLLER
// ==========================================================================
function renderScanner() {
  const products = CartKaroStore.getProducts();
  
  // Render quick test barcode pills
  const pillsContainer = document.getElementById('sample-barcode-pills');
  if (pillsContainer) {
    pillsContainer.innerHTML = products.slice(0, 6).map(p => `
      <button type="button" class="btn btn-outline-secondary btn-sm sample-barcode-pill" data-code="${p.barcode}">
        <i class="bi bi-upc me-1"></i>${p.name.split(' ')[0]} (${p.barcode.slice(-4)})
      </button>
    `).join('');
  }

  // Auto-focus barcode input
  setTimeout(() => {
    const input = document.getElementById('barcode-input');
    if (input) input.focus();
  }, 100);
}

function handleBarcodeLookup(barcode) {
  barcode = (barcode || '').trim();
  if (!barcode) return;

  const products = CartKaroStore.getProducts();
  const product = products.find(p => p.barcode === barcode || p.id.toLowerCase() === barcode.toLowerCase());

  const emptyState = document.getElementById('scanner-empty-state');
  const detailsState = document.getElementById('scanner-product-details');
  const unknownState = document.getElementById('scanner-unknown-state');
  const statusBadge = document.getElementById('scanner-status-badge');

  emptyState.classList.add('d-none');

  if (product) {
    // Sound & status
    SoundFx.beep(1400, 0.08);
    statusBadge.textContent = 'Product Found';
    statusBadge.className = 'badge bg-success-subtle text-success border border-success-subtle';

    unknownState.classList.add('d-none');
    detailsState.classList.remove('d-none');

    // Fill details
    document.getElementById('scan-res-name').textContent = product.name;
    document.getElementById('scan-res-category').textContent = product.category;
    document.getElementById('scan-res-barcode').textContent = product.barcode;
    document.getElementById('scan-res-price').textContent = formatINR(product.sellingPrice);
    document.getElementById('scan-res-cost').textContent = formatINR(product.costPrice);
    document.getElementById('scan-res-stock').textContent = `${product.quantity} Units`;
    document.getElementById('scan-res-supplier').textContent = product.supplier || '--';
    document.getElementById('scan-res-expiry').textContent = product.expiryDate ? formatDateOnly(product.expiryDate) : '--';

    const margin = product.costPrice > 0 ? (((product.sellingPrice - product.costPrice) / product.costPrice) * 100).toFixed(1) : 0;
    document.getElementById('scan-res-margin').textContent = `${margin}%`;

    const isOut = product.quantity <= 0;
    const isLow = !isOut && product.quantity <= (product.minStock || 10);
    const stockBadge = document.getElementById('scan-res-stock-badge');
    stockBadge.innerHTML = isOut ? '<span class="badge bg-danger">Out of Stock</span>' : 
                           isLow ? '<span class="badge bg-warning text-dark">Low Stock Alert</span>' : 
                                   '<span class="badge bg-success">In Stock</span>';

    // Configure Add to Cart button
    const addCartBtn = document.getElementById('scan-add-to-cart-btn');
    addCartBtn.disabled = isOut;
    addCartBtn.onclick = () => {
      addToCart(product.id);
      showToast(`Added "${product.name}" to POS cart!`);
      switchView('pos');
    };

    // Quick restock button
    document.getElementById('scan-quick-stock-btn').onclick = () => {
      openStockModal(product.id, 'IN');
    };

  } else {
    // Not found
    SoundFx.alertTone();
    statusBadge.textContent = 'Unregistered Barcode';
    statusBadge.className = 'badge bg-danger-subtle text-danger border border-danger-subtle';

    detailsState.classList.add('d-none');
    unknownState.classList.remove('d-none');
    document.getElementById('scan-unknown-code').textContent = barcode;

    document.getElementById('scan-create-product-btn').onclick = () => {
      openProductModal('add');
      setTimeout(() => {
        document.getElementById('prod-barcode').value = barcode;
      }, 200);
    };
  }
}

// ==========================================================================
// 9. POINT-OF-SALE (POS) BILLING SYSTEM
// ==========================================================================
function renderPOS() {
  document.getElementById('pos-current-bill-no').textContent = '#' + AppState.cartBillNo;
  renderPOSProductGrid();
  renderPOSCart();
}

function renderPOSProductGrid() {
  const products = CartKaroStore.getProducts();
  const search = (document.getElementById('pos-search-input')?.value || '').toLowerCase().trim();
  const activeCatBtn = document.querySelector('#pos-category-pills .btn.active');
  const catFilter = activeCatBtn ? activeCatBtn.dataset.category : '';

  // Render Category Filter Pills if empty
  const pillsContainer = document.getElementById('pos-category-pills');
  if (pillsContainer && pillsContainer.children.length <= 1) {
    const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
    cats.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-outline-primary rounded-pill px-3 py-1 text-nowrap';
      btn.dataset.category = c;
      btn.textContent = c;
      btn.addEventListener('click', () => {
        pillsContainer.querySelectorAll('.btn').forEach(b => {
          b.classList.remove('btn-primary', 'active');
          b.classList.add('btn-outline-primary');
        });
        btn.classList.add('btn-primary', 'active');
        btn.classList.remove('btn-outline-primary');
        renderPOSProductGrid();
      });
      pillsContainer.appendChild(btn);
    });
  }

  // Filter products
  const filtered = products.filter(p => {
    const matchSearch = !search || 
      p.name.toLowerCase().includes(search) || 
      p.barcode.includes(search);
    const matchCat = !catFilter || p.category === catFilter;
    return matchSearch && matchCat;
  });

  const grid = document.getElementById('pos-products-grid');
  const emptyState = document.getElementById('pos-grid-empty');

  if (filtered.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('d-none');
    return;
  }

  emptyState.classList.add('d-none');
  grid.innerHTML = filtered.map(p => {
    const isOut = p.quantity <= 0;
    const isLow = !isOut && p.quantity <= (p.minStock || 10);
    
    // Choose icon by category
    let icon = 'bi-box-seam';
    if (p.category.includes('Groceries')) icon = 'bi-basket2';
    else if (p.category.includes('Dairy')) icon = 'bi-egg';
    else if (p.category.includes('Beverages')) icon = 'bi-cup-straw';
    else if (p.category.includes('Snacks')) icon = 'bi-cake2';
    else if (p.category.includes('Personal')) icon = 'bi-heart-pulse';
    else if (p.category.includes('Household')) icon = 'bi-shield-check';

    return `
      <div class="col-6 col-sm-4 col-md-4 col-lg-3">
        <div class="card h-100 pos-product-card ${isOut ? 'out-of-stock' : ''} p-2 d-flex flex-column justify-content-between" data-id="${p.id}">
          <div class="d-flex align-items-center justify-content-between mb-2">
            <div class="pos-product-icon-wrap">
              <i class="bi ${icon}"></i>
            </div>
            <span class="badge ${isOut ? 'bg-danger' : isLow ? 'bg-warning text-dark' : 'bg-light text-muted border'} small">
              ${isOut ? 'Out of Stock' : `${p.quantity} Left`}
            </span>
          </div>

          <div>
            <div class="fw-semibold text-dark text-truncate small mb-1" title="${p.name}">${p.name}</div>
            <small class="text-muted font-monospace d-block" style="font-size: 0.72rem;"><i class="bi bi-upc me-1"></i>${p.barcode}</small>
          </div>

          <div class="d-flex align-items-center justify-content-between mt-2 pt-2 border-top">
            <strong class="text-primary fs-6">${formatINR(p.sellingPrice)}</strong>
            <button class="btn btn-sm btn-primary rounded-circle p-0 cart-qty-btn ${isOut ? 'disabled' : ''}" title="Add to Cart">
              <i class="bi bi-plus-lg"></i>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function addToCart(productId, qtyToAdd = 1) {
  const products = CartKaroStore.getProducts();
  const product = products.find(p => p.id === productId);
  if (!product) return;

  if (product.quantity <= 0) {
    showToast(`"${product.name}" is OUT OF STOCK!`, true);
    SoundFx.alertTone();
    return;
  }

  const existing = AppState.cart.find(item => item.productId === productId);
  const currentInCart = existing ? existing.quantity : 0;

  if (currentInCart + qtyToAdd > product.quantity) {
    showToast(`Cannot add more than available stock (${product.quantity} units)!`, true);
    SoundFx.alertTone();
    return;
  }

  SoundFx.beep(1200, 0.06);

  if (existing) {
    existing.quantity += qtyToAdd;
    existing.amount = existing.quantity * existing.rate;
  } else {
    AppState.cart.push({
      productId: product.id,
      name: product.name,
      barcode: product.barcode,
      rate: product.sellingPrice,
      quantity: qtyToAdd,
      amount: qtyToAdd * product.sellingPrice,
      costPrice: product.costPrice
    });
  }

  renderPOSCart();
}

function updateCartQty(productId, newQty) {
  const products = CartKaroStore.getProducts();
  const product = products.find(p => p.id === productId);
  const item = AppState.cart.find(i => i.productId === productId);
  if (!item || !product) return;

  newQty = parseInt(newQty, 10);
  if (isNaN(newQty) || newQty <= 0) {
    removeFromCart(productId);
    return;
  }

  if (newQty > product.quantity) {
    showToast(`Stock limit reached! Only ${product.quantity} available.`, true);
    newQty = product.quantity;
    SoundFx.alertTone();
  } else {
    SoundFx.beep(1000, 0.05);
  }

  item.quantity = newQty;
  item.amount = item.quantity * item.rate;
  renderPOSCart();
}

function removeFromCart(productId) {
  AppState.cart = AppState.cart.filter(item => item.productId !== productId);
  renderPOSCart();
  SoundFx.beep(600, 0.08, 'square');
}

function clearCart() {
  if (AppState.cart.length === 0) return;
  AppState.cart = [];
  renderPOSCart();
  showToast('Cart cleared.');
}

function renderPOSCart() {
  const tbody = document.getElementById('pos-cart-tbody');
  const emptyState = document.getElementById('pos-cart-empty');
  const badge = document.getElementById('pos-cart-badge');

  const totalItemsCount = AppState.cart.reduce((sum, i) => sum + i.quantity, 0);
  badge.textContent = `${totalItemsCount} Items`;

  if (AppState.cart.length === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('d-none');
    calculatePOSBill(0);
    return;
  }

  emptyState.classList.add('d-none');
  tbody.innerHTML = AppState.cart.map(item => `
    <tr>
      <td>
        <div class="fw-semibold text-truncate small" style="max-width: 130px;">${item.name}</div>
        <small class="text-muted font-monospace" style="font-size: 0.72rem;">${item.barcode}</small>
      </td>
      <td class="text-center">
        <div class="d-inline-flex align-items-center gap-1">
          <button class="btn btn-outline-secondary btn-sm cart-qty-btn cart-minus-btn" data-id="${item.productId}">-</button>
          <input type="number" class="form-control form-control-sm text-center p-0 cart-qty-input" style="width: 36px; height: 26px;" value="${item.quantity}" min="1" data-id="${item.productId}">
          <button class="btn btn-outline-secondary btn-sm cart-qty-btn cart-plus-btn" data-id="${item.productId}">+</button>
        </div>
      </td>
      <td class="text-end font-monospace small">${formatINR(item.rate)}</td>
      <td class="text-end font-monospace fw-bold small">${formatINR(item.amount)}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-link p-0 text-danger cart-remove-btn" data-id="${item.productId}">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    </tr>
  `).join('');

  const subtotal = AppState.cart.reduce((sum, i) => sum + i.amount, 0);
  calculatePOSBill(subtotal);
}

function calculatePOSBill(subtotal) {
  subtotal = round2(subtotal);
  document.getElementById('pos-calc-subtotal').textContent = formatINR(subtotal);

  // Discount (rounded to paise exactly like the database function does)
  const discType = document.getElementById('pos-discount-type').value;
  const discVal = parseFloat(document.getElementById('pos-discount-val').value) || 0;
  let discountAmount = 0;
  if (discType === 'percent') {
    discountAmount = round2((subtotal * Math.min(100, Math.max(0, discVal))) / 100);
  } else {
    discountAmount = round2(Math.min(subtotal, Math.max(0, discVal)));
  }

  const taxableAmount = round2(Math.max(0, subtotal - discountAmount));

  // GST
  const gstRate = parseFloat(document.getElementById('pos-gst-select').value) || 0;
  document.getElementById('pos-gst-label').textContent = `${gstRate}%`;
  const gstAmount = round2((taxableAmount * gstRate) / 100);
  document.getElementById('pos-calc-gst').textContent = formatINR(gstAmount);

  // Grand Total
  const grandTotal = round2(taxableAmount + gstAmount);
  document.getElementById('pos-calc-grand-total').textContent = formatINR(grandTotal);

  // Cash change due calculation
  const cashReceivedInput = document.getElementById('pos-cash-received');
  const cashReceived = parseFloat(cashReceivedInput.value) || 0;
  const changeDueEl = document.getElementById('pos-change-due');
  const changeDue = round2(Math.max(0, cashReceived - grandTotal));
  changeDueEl.textContent = formatINR(changeDue);

  return { subtotal, discountAmount, gstRate, gstAmount, grandTotal, cashReceived, changeDue };
}

async function handlePOSCheckout() {
  // Block double-clicks / Enter-key repeats while a sale is being saved.
  if (AppState.checkoutInFlight) return;

  if (AppState.cart.length === 0) {
    showToast('Cannot complete checkout: Cart is empty!', true);
    SoundFx.alertTone();
    return;
  }

  const subtotal = AppState.cart.reduce((sum, i) => sum + i.amount, 0);
  const billCalc = calculatePOSBill(subtotal);
  const paymentMethod = document.querySelector('input[name="paymentMode"]:checked').value;

  if (paymentMethod === 'Cash' && billCalc.cashReceived > 0 && billCalc.cashReceived < billCalc.grandTotal) {
    showToast(`Cash tendered (${formatINR(billCalc.cashReceived)}) is less than total payable (${formatINR(billCalc.grandTotal)})!`, true);
    SoundFx.alertTone();
    return;
  }

  const typedName = document.getElementById('pos-customer-name').value.trim();
  const phoneRaw = document.getElementById('pos-customer-phone').value.trim();
  const phoneDigits = phoneRaw.replace(/\D/g, '').slice(-10);
  const cardRef = document.getElementById('pos-card-ref').value.trim();

  if (phoneRaw && phoneDigits.length !== 10) {
    showToast('Customer phone must have 10 digits (or leave it blank for a walk-in customer).', true);
    SoundFx.alertTone();
    return;
  }

  // Map cart lines to database product ids
  const products = CartKaroStore.getProducts();
  const items = [];
  for (const line of AppState.cart) {
    const prod = products.find(p => p.id === line.productId);
    if (!prod || !prod.dbId) {
      showToast(`"${line.name}" is not in the database any more. Remove it from the cart.`, true);
      SoundFx.alertTone();
      return;
    }
    items.push({ product_id: prod.dbId, quantity: line.quantity });
  }

  const payload = {
    p_request_id: null,
    p_customer_name: typedName || null,
    p_customer_phone: phoneDigits || null,
    p_items: items,
    p_discount_type: document.getElementById('pos-discount-type').value,
    p_discount_value: parseFloat(document.getElementById('pos-discount-val').value) || 0,
    p_gst_rate: billCalc.gstRate,
    p_payment_method: paymentMethod.toUpperCase(),
    p_amount_tendered: paymentMethod === 'Cash' && billCalc.cashReceived > 0 ? billCalc.cashReceived : null,
    p_reference: cardRef || null
  };

  // Same request id for a retry of the SAME bill, so the database returns the
  // already-saved bill instead of creating a duplicate. Any change = new bill.
  const signature = JSON.stringify({ ...payload, p_request_id: null });
  if (!AppState.checkoutAttempt || AppState.checkoutAttempt.signature !== signature) {
    AppState.checkoutAttempt = { id: newRequestId(), signature };
  }
  payload.p_request_id = AppState.checkoutAttempt.id;

  const checkoutBtn = document.getElementById('pos-checkout-btn');
  const unlock = lockButton(checkoutBtn, '<span class="spinner-border spinner-border-sm me-2"></span>Saving bill...');
  AppState.checkoutInFlight = true;

  try {
    const result = await CartKaroDB.rpc('create_sale', payload);
    const newBill = mapRpcBill(result);
    if (!newBill.customerId && typedName) newBill.customerName = typedName; // walk-in who gave a name (name is printed only)

    AppState.checkoutAttempt = null;

    // Bill is saved. Reload live data (stock, dashboard, history).
    const sync = await CartKaroDB.refreshAll();

    SoundFx.successChime();
    if (result.already_processed) {
      showToast(`Bill ${newBill.billNo} was already saved - no duplicate was created.`);
    } else {
      showToast(`Bill ${newBill.billNo} saved (database ID ${newBill.billId}).`);
    }
    if (!sync.ok) showToast(`Bill saved, but the screens could not be refreshed: ${sync.error.message}`, true);

    openReceiptModal(newBill);

    // Reset Cart for next customer
    AppState.cart = [];
    AppState.cartBillNo = getNextBillNumber();
    document.getElementById('pos-customer-name').value = '';
    document.getElementById('pos-customer-phone').value = '';
    document.getElementById('pos-cash-received').value = '';
    document.getElementById('pos-card-ref').value = '';
    renderPOS();
    updateStockAlertsBadge();
  } catch (err) {
    const e = wrapDbError(err);
    console.error('[CartKaro] checkout failed:', err, payload);
    // Cart is kept. Retrying the same cart reuses the request id, so it cannot double-bill.
    showToast(`Bill was NOT completed: ${e.message}`, true);
    SoundFx.alertTone();
    if (e.code === 'P0001' || /stock/i.test(e.message)) CartKaroDB.refreshAll(); // show live stock
  } finally {
    AppState.checkoutInFlight = false;
    unlock();
  }
}

// ==========================================================================
// 10. THERMAL RECEIPT MODAL & PRINT CONTROLLER
// ==========================================================================
function openReceiptModal(bill) {
  const settings = CartKaroStore.getSettings();

  document.getElementById('rcpt-shop-name').textContent = settings.shopName;
  document.getElementById('rcpt-tagline').textContent = settings.tagline;
  document.getElementById('rcpt-address').textContent = settings.address;
  document.getElementById('rcpt-phone').textContent = settings.phone;
  document.getElementById('rcpt-gstin').textContent = settings.gstin;
  document.getElementById('rcpt-footer-msg').textContent = settings.footerMsg;

  document.getElementById('rcpt-bill-no').textContent = '#' + bill.billNo;
  document.getElementById('rcpt-date-time').textContent = formatDateTime(bill.date);
  document.getElementById('rcpt-customer-name').textContent = bill.customerName || 'Walk-in';
  document.getElementById('rcpt-customer-phone').textContent = bill.customerPhone ? `(${bill.customerPhone})` : '';
  document.getElementById('rcpt-payment-mode').textContent = bill.paymentMethod;

  const tbody = document.getElementById('rcpt-items-tbody');
  tbody.innerHTML = bill.items.map(item => `
    <tr>
      <td class="ps-0">${item.name}</td>
      <td class="text-center">${item.quantity}</td>
      <td class="text-end">${formatINR(item.rate)}</td>
      <td class="text-end pe-0 fw-bold">${formatINR(item.amount || (item.rate * item.quantity))}</td>
    </tr>
  `).join('');

  document.getElementById('rcpt-subtotal').textContent = formatINR(bill.subtotal);

  const discRow = document.getElementById('rcpt-discount-row');
  if (bill.discountAmount > 0) {
    discRow.classList.remove('d-none');
    document.getElementById('rcpt-discount').textContent = '-' + formatINR(bill.discountAmount);
  } else {
    discRow.classList.add('d-none');
  }

  document.getElementById('rcpt-gst-rate').textContent = `${bill.gstRate || 0}%`;
  document.getElementById('rcpt-gst').textContent = formatINR(bill.gstAmount);
  document.getElementById('rcpt-grand-total').textContent = formatINR(bill.grandTotal);

  const tenderRow = document.getElementById('rcpt-tendered-row');
  const changeRow = document.getElementById('rcpt-change-row');
  if (bill.paymentMethod === 'Cash' && bill.amountPaid) {
    tenderRow.classList.remove('d-none');
    changeRow.classList.remove('d-none');
    document.getElementById('rcpt-tendered').textContent = formatINR(bill.amountPaid);
    document.getElementById('rcpt-change').textContent = formatINR(bill.changeDue);
  } else {
    tenderRow.classList.add('d-none');
    changeRow.classList.add('d-none');
  }

  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('receipt-modal'));
  modal.show();
}

// ==========================================================================
// 11. SALES HISTORY CONTROLLER
// ==========================================================================
function renderSales() {
  const bills = CartKaroStore.getBills();
  const search = (document.getElementById('sales-search-input')?.value || '').toLowerCase().trim();
  const dateFilter = document.getElementById('sales-date-filter')?.value || 'all';
  const payFilter = document.getElementById('sales-payment-filter')?.value || '';
  const sortFilter = document.getElementById('sales-sort-filter')?.value || 'date-desc';

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yestStr = yesterday.toISOString().slice(0, 10);

  let filtered = bills.filter(b => {
    const matchSearch = !search || 
      b.billNo.toLowerCase().includes(search) || 
      (b.customerName && b.customerName.toLowerCase().includes(search)) || 
      (b.customerPhone && b.customerPhone.includes(search));

    const matchPay = !payFilter || b.paymentMethod === payFilter;

    let matchDate = true;
    const bDate = b.date.slice(0, 10);
    if (dateFilter === 'today') matchDate = bDate === todayStr;
    else if (dateFilter === 'yesterday') matchDate = bDate === yestStr;
    else if (dateFilter === 'week') {
      const diffDays = (now - new Date(b.date)) / (1000 * 3600 * 24);
      matchDate = diffDays <= 7;
    } else if (dateFilter === 'month') {
      const bd = new Date(b.date);
      matchDate = bd.getFullYear() === now.getFullYear() && bd.getMonth() === now.getMonth();
    }

    return matchSearch && matchPay && matchDate;
  });

  // Sort
  filtered.sort((a, b) => {
    switch (sortFilter) {
      case 'date-desc': return new Date(b.date) - new Date(a.date);
      case 'date-asc': return new Date(a.date) - new Date(b.date);
      case 'amt-desc': return b.grandTotal - a.grandTotal;
      case 'amt-asc': return a.grandTotal - b.grandTotal;
      default: return 0;
    }
  });

  // Summary Banner
  const totalCount = filtered.length;
  const totalRev = filtered.filter(b => b.status === 'Completed').reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
  const avgRev = totalCount > 0 ? (totalRev / totalCount) : 0;

  document.getElementById('sales-summary-count').textContent = totalCount;
  document.getElementById('sales-summary-revenue').textContent = formatINR(totalRev);
  document.getElementById('sales-summary-avg').textContent = formatINR(avgRev);

  // Pagination
  const perPage = AppState.salesPerPage;
  const totalPages = Math.ceil(totalCount / perPage) || 1;
  if (AppState.salesPage > totalPages) AppState.salesPage = totalPages;
  const start = (AppState.salesPage - 1) * perPage;
  const paged = filtered.slice(start, start + perPage);

  const tbody = document.getElementById('sales-tbody');
  const emptyState = document.getElementById('sales-empty');
  const countInfo = document.getElementById('sales-count-info');

  if (countInfo) {
    countInfo.textContent = totalCount > 0 
      ? `Showing ${start + 1} to ${Math.min(start + perPage, totalCount)} of ${totalCount} invoices`
      : 'Showing 0 invoices';
  }

  if (totalCount === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('d-none');
    renderSalesPagination(0, 1);
    return;
  }

  emptyState.classList.add('d-none');
  tbody.innerHTML = paged.map(b => {
    const isReturned = b.status === 'Returned';
    const payBadge = b.paymentMethod === 'Cash' ? 'bg-success-subtle text-success border border-success-subtle' :
                     b.paymentMethod === 'UPI' ? 'bg-primary-subtle text-primary border border-primary-subtle' :
                                                 'bg-purple-subtle text-purple border';

    return `
      <tr class="${isReturned ? 'table-light opacity-75' : ''}">
        <td class="ps-3 font-monospace fw-bold text-primary">${b.billNo}</td>
        <td class="small text-muted font-monospace">${formatDateTime(b.date)}</td>
        <td>
          <div class="fw-semibold text-dark">${b.customerName || 'Walk-in'}</div>
          ${b.customerPhone ? `<small class="text-muted"><i class="bi bi-telephone me-1"></i>${b.customerPhone}</small>` : ''}
        </td>
        <td class="text-center font-monospace">${b.items ? b.items.length : 0} items</td>
        <td><span class="badge ${payBadge}">${b.paymentMethod}</span></td>
        <td class="text-end fw-bold font-monospace ${isReturned ? 'text-decoration-line-through text-muted' : 'text-dark'}">
          ${formatINR(b.grandTotal)}
        </td>
        <td>
          <span class="badge ${isReturned ? 'bg-danger' : 'bg-success'}">${b.status || 'Completed'}</span>
        </td>
        <td class="text-end pe-3">
          <div class="btn-group btn-group-sm">
            <button class="btn btn-light border view-bill-receipt-btn" data-bill="${b.billNo}" title="View & Print Receipt">
              <i class="bi bi-receipt text-primary"></i>
            </button>
            ${!isReturned ? `
              <button class="btn btn-light border void-bill-btn" data-bill="${b.billNo}" title="Return / Void Invoice">
                <i class="bi bi-arrow-return-left text-danger"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderSalesPagination(totalPages, AppState.salesPage);
}

function renderSalesPagination(totalPages, currentPage) {
  const container = document.getElementById('sales-pagination');
  if (!container) return;
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <li class="page-item ${currentPage === 1 ? 'disabled' : ''}">
      <button class="page-link" data-page="${currentPage - 1}">&laquo;</button>
    </li>
  `;

  for (let i = 1; i <= totalPages; i++) {
    html += `
      <li class="page-item ${i === currentPage ? 'active' : ''}">
        <button class="page-link" data-page="${i}">${i}</button>
      </li>
    `;
  }

  html += `
    <li class="page-item ${currentPage === totalPages ? 'disabled' : ''}">
      <button class="page-link" data-page="${currentPage + 1}">&raquo;</button>
    </li>
  `;

  container.innerHTML = html;
}

function voidBill(billNo) {
  const bills = CartKaroStore.getBills();
  const bill = bills.find(b => b.billNo === billNo);
  if (!bill || bill.status === 'Returned') return;

  openConfirmModal({
    title: 'Return / Void Invoice?',
    message: `Are you sure you want to void Bill ${billNo} (${formatINR(bill.grandTotal)})? All purchased items will be restored to inventory stock.`,
    iconClass: 'bi-arrow-return-left',
    onConfirm: async () => {
      if (AppState.voidingBill) return;
      AppState.voidingBill = true;
      try {
        await CartKaroDB.rpc('void_bill', { p_bill_id: bill.billId });
        const sync = await CartKaroDB.refreshAll();
        showToast(`Bill ${billNo} has been marked as Returned and stock restored.`);
        SoundFx.beep(750, 0.15);
        if (!sync.ok) showToast(`Saved, but the list could not be refreshed: ${sync.error.message}`, true);
      } catch (err) {
        const e = wrapDbError(err);
        console.error('[CartKaro] void bill failed:', err);
        showToast(`Bill was NOT voided: ${e.message}`, true);
        SoundFx.alertTone();
        CartKaroDB.refreshAll();
      } finally {
        AppState.voidingBill = false;
      }
    }
  });
}

// ==========================================================================
// 12. REPORTS & ANALYTICS CONTROLLER
// ==========================================================================
function renderReports() {
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');
  const products = CartKaroStore.getProducts();

  // Gross Sales
  const grossSales = bills.reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
  
  // Total Profit Margin Estimation
  let totalCostSold = 0;
  bills.forEach(b => {
    (b.items || []).forEach(item => {
      const prod = products.find(p => p.id === item.productId);
      const itemCost = prod ? prod.costPrice : (item.costPrice || (item.rate * 0.75));
      totalCostSold += (itemCost * item.quantity);
    });
  });
  const estProfit = Math.max(0, grossSales - totalCostSold);
  const marginPct = grossSales > 0 ? ((estProfit / grossSales) * 100).toFixed(1) : 0;

  // Average Bill
  const avgBill = bills.length > 0 ? (grossSales / bills.length) : 0;

  // Stock Valuation
  const stockValuation = products.reduce((sum, p) => sum + (p.quantity * p.costPrice), 0);

  document.getElementById('rep-gross-sales').textContent = formatINR(grossSales);
  document.getElementById('rep-profit-margin').textContent = formatINR(estProfit);
  document.getElementById('rep-profit-pct').textContent = `(${marginPct}% Gross Margin)`;
  document.getElementById('rep-avg-bill').textContent = formatINR(avgBill);
  document.getElementById('rep-stock-val').textContent = formatINR(stockValuation);

  // Render Charts
  renderReportsSalesTrendChart();
  renderReportsCategoryChart();

  // Render Best Sellers & Slow Sellers Tables
  renderReportsTables();
}

function renderReportsSalesTrendChart() {
  const canvas = document.getElementById('reports-sales-trend-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');

  const now = new Date();
  const labels = [];
  const revenueData = [];
  const billsData = [];

  for (let m = 5; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    labels.push(d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }));
    const mYear = d.getFullYear();
    const mMonth = d.getMonth();

    const mBills = bills.filter(b => {
      const bd = new Date(b.date);
      return bd.getFullYear() === mYear && bd.getMonth() === mMonth;
    });

    const mRev = mBills.reduce((sum, b) => sum + Number(b.grandTotal || 0), 0);
    revenueData.push(mRev);
    billsData.push(mBills.length);
  }

  if (AppState.charts.repSales) {
    AppState.charts.repSales.destroy();
  }

  AppState.charts.repSales = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Revenue (₹)',
          data: revenueData,
          borderColor: '#1e40af',
          backgroundColor: 'rgba(30, 64, 175, 0.1)',
          fill: true,
          tension: 0.35,
          yAxisID: 'y'
        },
        {
          label: 'Invoices Count',
          data: billsData,
          borderColor: '#10b981',
          borderDash: [5, 5],
          tension: 0.35,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          ticks: { callback: val => '₹' + val }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { stepSize: 1 }
        }
      }
    }
  });
}

function renderReportsCategoryChart() {
  const canvas = document.getElementById('reports-category-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');
  const products = CartKaroStore.getProducts();

  const catMap = {};
  bills.forEach(b => {
    (b.items || []).forEach(item => {
      const prod = products.find(p => p.id === item.productId);
      const cat = prod ? prod.category : 'General';
      catMap[cat] = (catMap[cat] || 0) + Number(item.amount || (item.rate * item.quantity));
    });
  });

  const labels = Object.keys(catMap);
  const data = Object.values(catMap);

  if (AppState.charts.repCategory) {
    AppState.charts.repCategory.destroy();
  }

  AppState.charts.repCategory = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: labels.length > 0 ? labels : ['No Data'],
      datasets: [{
        data: data.length > 0 ? data : [1],
        backgroundColor: ['#2563eb', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#64748b']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: context => ` ${context.label}: ${formatINR(context.raw)}`
          }
        }
      }
    }
  });
}

function renderReportsTables() {
  const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');
  const products = CartKaroStore.getProducts();

  const salesMap = {};
  products.forEach(p => {
    salesMap[p.id] = { product: p, units: 0, revenue: 0 };
  });

  bills.forEach(b => {
    (b.items || []).forEach(item => {
      if (salesMap[item.productId]) {
        salesMap[item.productId].units += Number(item.quantity || 0);
        salesMap[item.productId].revenue += Number(item.amount || (item.rate * item.quantity));
      }
    });
  });

  const allItems = Object.values(salesMap);
  const bestSellers = [...allItems].sort((a, b) => b.units - a.units).slice(0, 5);
  const slowSellers = [...allItems].sort((a, b) => a.units - b.units).slice(0, 5);

  const bestTbody = document.getElementById('rep-bestsellers-tbody');
  bestTbody.innerHTML = bestSellers.map(i => `
    <tr>
      <td class="fw-semibold">${i.product.name}</td>
      <td><span class="badge bg-light text-secondary border">${i.product.category}</span></td>
      <td class="text-center font-monospace">${i.units}</td>
      <td class="text-end font-monospace fw-bold">${formatINR(i.revenue)}</td>
    </tr>
  `).join('');

  const slowTbody = document.getElementById('rep-slowsellers-tbody');
  slowTbody.innerHTML = slowSellers.map(i => `
    <tr>
      <td class="fw-semibold">${i.product.name}</td>
      <td><span class="badge bg-light text-secondary border">${i.product.category}</span></td>
      <td class="text-center font-monospace">${i.product.quantity} Units</td>
      <td class="text-center font-monospace text-muted">${i.units} sold</td>
    </tr>
  `).join('');
}

// ==========================================================================
// 13. SETTINGS & BACKUP CONTROLLER
// ==========================================================================
function renderSettings() {
  const settings = CartKaroStore.getSettings();

  document.getElementById('set-shop-name').value = settings.shopName || '';
  document.getElementById('set-tagline').value = settings.tagline || '';
  document.getElementById('set-address').value = settings.address || '';
  document.getElementById('set-phone').value = settings.phone || '';
  document.getElementById('set-email').value = settings.email || '';
  document.getElementById('set-gstin').value = settings.gstin || '';
  document.getElementById('set-currency').value = settings.currency || '₹';
  document.getElementById('set-default-gst').value = settings.defaultGst !== undefined ? settings.defaultGst : 5;
  document.getElementById('set-default-discount').value = settings.defaultDiscount || 0;
  document.getElementById('set-min-stock').value = settings.lowStockThreshold || 10;
  document.getElementById('set-receipt-footer').value = settings.footerMsg || '';

  // Update sidebar store name
  const sideShopName = document.getElementById('sidebar-shop-name');
  if (sideShopName) sideShopName.textContent = settings.shopName || 'CartKaro Supermarket';
}

function handleSettingsSubmit(e) {
  e.preventDefault();
  const settings = {
    shopName: document.getElementById('set-shop-name').value.trim(),
    tagline: document.getElementById('set-tagline').value.trim(),
    address: document.getElementById('set-address').value.trim(),
    phone: document.getElementById('set-phone').value.trim(),
    email: document.getElementById('set-email').value.trim(),
    gstin: document.getElementById('set-gstin').value.trim(),
    currency: '₹',
    defaultGst: parseFloat(document.getElementById('set-default-gst').value) || 0,
    defaultDiscount: parseFloat(document.getElementById('set-default-discount').value) || 0,
    lowStockThreshold: parseInt(document.getElementById('set-min-stock').value, 10) || 10,
    footerMsg: document.getElementById('set-receipt-footer').value.trim()
  };

  CartKaroStore.saveSettings(settings);
  showToast('Store settings saved successfully!');
  SoundFx.successChime();
  renderSettings();
  updateStockAlertsBadge();
}

function exportDatabaseBackup() {
  const data = {
    app: 'CartKaro',
    version: '2.0',
    exportedAt: new Date().toISOString(),
    products: CartKaroStore.getProducts(),
    bills: CartKaroStore.getBills(),
    movements: CartKaroStore.getMovements(),
    settings: CartKaroStore.getSettings()
  };

  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cartkaro-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Database backup downloaded successfully.');
}

function importDatabaseBackup(file) {
  // Restoring a JSON file would only change the browser cache, never the database,
  // so it is intentionally disabled. Use the Supabase SQL Editor to restore data.
  showToast('Restore is disabled: data lives in Supabase. Use the Supabase dashboard to restore a database backup.', true);
}

// Export CSV Helper
function exportToCSV(filename, rows) {
  const processRow = row => row.map(val => {
    const str = val === null || val === undefined ? '' : String(val);
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  }).join(',');

  const csvContent = 'data:text/csv;charset=utf-8,' + rows.map(processRow).join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ==========================================================================
// 14. GLOBAL SEARCH CONTROLLER
// ==========================================================================
function setupGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const resultsDropdown = document.getElementById('global-search-results');
  if (!input || !resultsDropdown) return;

  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    if (!query) {
      resultsDropdown.classList.add('d-none');
      return;
    }

    const products = CartKaroStore.getProducts();
    const bills = CartKaroStore.getBills();

    const matchedProducts = products.filter(p => 
      p.name.toLowerCase().includes(query) || 
      p.barcode.includes(query) || 
      p.id.toLowerCase().includes(query)
    ).slice(0, 4);

    const matchedBills = bills.filter(b => 
      b.billNo.toLowerCase().includes(query) || 
      (b.customerName && b.customerName.toLowerCase().includes(query))
    ).slice(0, 3);

    if (matchedProducts.length === 0 && matchedBills.length === 0) {
      resultsDropdown.innerHTML = '<div class="p-3 text-center text-muted small">No matches found for "' + query + '"</div>';
      resultsDropdown.classList.remove('d-none');
      return;
    }

    let html = '';
    if (matchedProducts.length > 0) {
      html += '<h6 class="dropdown-header text-uppercase text-primary fw-bold">Products</h6>';
      matchedProducts.forEach(p => {
        html += `
          <a href="#products" class="dropdown-item d-flex align-items-center justify-content-between p-2 global-search-prod-item" data-id="${p.id}">
            <div>
              <div class="fw-semibold text-dark small">${p.name}</div>
              <small class="text-muted font-monospace"><i class="bi bi-upc me-1"></i>${p.barcode}</small>
            </div>
            <strong class="text-primary small">${formatINR(p.sellingPrice)}</strong>
          </a>
        `;
      });
    }

    if (matchedBills.length > 0) {
      html += '<h6 class="dropdown-header text-uppercase text-success fw-bold mt-2">Invoices</h6>';
      matchedBills.forEach(b => {
        html += `
          <a href="#sales" class="dropdown-item d-flex align-items-center justify-content-between p-2 global-search-bill-item" data-bill="${b.billNo}">
            <div>
              <strong class="font-monospace text-dark small">${b.billNo}</strong>
              <small class="text-muted d-block">${b.customerName || 'Walk-in'}</small>
            </div>
            <strong class="text-success small">${formatINR(b.grandTotal)}</strong>
          </a>
        `;
      });
    }

    resultsDropdown.innerHTML = html;
    resultsDropdown.classList.remove('d-none');
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !resultsDropdown.contains(e.target)) {
      resultsDropdown.classList.add('d-none');
    }
  });

  // Delegated click for search results
  resultsDropdown.addEventListener('click', e => {
    const prodItem = e.target.closest('.global-search-prod-item');
    if (prodItem) {
      resultsDropdown.classList.add('d-none');
      input.value = '';
      switchView('products');
      setTimeout(() => {
        document.getElementById('prod-search-input').value = prodItem.dataset.id;
        renderProducts();
      }, 100);
      return;
    }

    const billItem = e.target.closest('.global-search-bill-item');
    if (billItem) {
      resultsDropdown.classList.add('d-none');
      input.value = '';
      const bill = CartKaroStore.getBills().find(b => b.billNo === billItem.dataset.bill);
      if (bill) openReceiptModal(bill);
    }
  });
}

// ==========================================================================
// 15. GLOBAL EVENT LISTENERS & INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  // 1. Setup Hash Router & Nav buttons
  document.querySelectorAll('.nav-link-btn, .sidebar .nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const target = link.dataset.target;
      if (target) {
        window.location.hash = target;
        switchView(target);
      }
    });
  });

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '') || 'dashboard';
    switchView(hash);
  });

  // 2. Sidebar Toggle Buttons
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const closeBtn = document.getElementById('sidebar-close-btn');
  const backdrop = document.getElementById('sidebar-backdrop');

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (window.innerWidth >= 992) {
        document.body.classList.toggle('sidebar-collapsed');
      } else {
        document.body.classList.toggle('sidebar-mobile-open');
        backdrop.classList.toggle('d-none');
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.body.classList.remove('sidebar-mobile-open');
      backdrop.classList.add('d-none');
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', () => {
      document.body.classList.remove('sidebar-mobile-open');
      backdrop.classList.add('d-none');
    });
  }

  // 3. Global Search Setup
  setupGlobalSearch();

  // 4. Clock and Alerts Heartbeat
  startClockAndHeartbeat();

  // 5. Dashboard Actions
  const chartPeriodGroup = document.getElementById('dashboard-chart-period-group');
  if (chartPeriodGroup) {
    chartPeriodGroup.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      chartPeriodGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderDashboardSalesChart(btn.dataset.period);
    });
  }

  // Delegated Dashboard click for Restock & Receipt view
  document.addEventListener('click', e => {
    const restockBtn = e.target.closest('.quick-restock-btn');
    if (restockBtn) {
      openStockModal(restockBtn.dataset.id, 'IN');
      return;
    }

    const viewRcptBtn = e.target.closest('.view-rcpt-btn');
    if (viewRcptBtn) {
      const bill = CartKaroStore.getBills().find(b => b.billNo === viewRcptBtn.dataset.bill);
      if (bill) openReceiptModal(bill);
    }
  });

  // 6. Product Management Events
  const addProductBtn = document.getElementById('add-product-btn');
  if (addProductBtn) addProductBtn.addEventListener('click', () => openProductModal('add'));

  const dashAddProductBtn = document.getElementById('dash-add-product-btn');
  if (dashAddProductBtn) dashAddProductBtn.addEventListener('click', () => openProductModal('add'));

  const productForm = document.getElementById('product-form');
  if (productForm) productForm.addEventListener('submit', handleProductFormSubmit);

  const btnGenProdId = document.getElementById('btn-gen-prod-id');
  if (btnGenProdId) {
    btnGenProdId.addEventListener('click', () => {
      const prods = CartKaroStore.getProducts();
      document.getElementById('prod-id').value = 'PRD-' + (prods.length + 1001 + Math.floor(Math.random() * 50));
    });
  }

  const btnGenBarcode = document.getElementById('btn-gen-barcode');
  if (btnGenBarcode) {
    btnGenBarcode.addEventListener('click', () => {
      document.getElementById('prod-barcode').value = '890103' + Math.floor(1000000 + Math.random() * 9000000);
    });
  }

  ['prod-search-input', 'prod-category-filter', 'prod-status-filter', 'prod-sort-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { AppState.productsPage = 1; renderProducts(); });
  });

  const productsPerPage = document.getElementById('products-per-page');
  if (productsPerPage) {
    productsPerPage.addEventListener('change', () => {
      AppState.productsPerPage = parseInt(productsPerPage.value, 10);
      AppState.productsPage = 1;
      renderProducts();
    });
  }

  const productsPagination = document.getElementById('products-pagination');
  if (productsPagination) {
    productsPagination.addEventListener('click', e => {
      const btn = e.target.closest('.page-link');
      if (btn && btn.dataset.page) {
        AppState.productsPage = parseInt(btn.dataset.page, 10);
        renderProducts();
      }
    });
  }

  // Delegated Edit / Delete product buttons
  document.getElementById('products-tbody')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.edit-prod-btn');
    if (editBtn) {
      openProductModal('edit', editBtn.dataset.id);
      return;
    }
    const delBtn = e.target.closest('.del-prod-btn');
    if (delBtn) {
      deleteProduct(delBtn.dataset.id);
    }
  });

  // Export Products CSV
  const exportProdCsvBtn = document.getElementById('export-products-csv-btn');
  if (exportProdCsvBtn) {
    exportProdCsvBtn.addEventListener('click', () => {
      const products = CartKaroStore.getProducts();
      const rows = [
        ['Product ID', 'Barcode', 'Product Name', 'Category', 'Cost Price (INR)', 'Selling Price (INR)', 'Quantity', 'Min Stock', 'Supplier', 'Expiry Date'],
        ...products.map(p => [p.id, p.barcode, p.name, p.category, p.costPrice, p.sellingPrice, p.quantity, p.minStock, p.supplier || '', p.expiryDate || ''])
      ];
      exportToCSV(`cartkaro-products-${new Date().toISOString().slice(0, 10)}.csv`, rows);
      showToast('Products catalog exported to CSV.');
    });
  }

  // 7. Inventory Management Events
  ['inv-search-input', 'inv-category-filter', 'inv-status-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderInventory);
  });

  const movementSearchInput = document.getElementById('movement-search-input');
  if (movementSearchInput) movementSearchInput.addEventListener('input', renderMovementAuditTable);

  const dashQuickStockBtn = document.getElementById('dash-quick-stock-btn');
  if (dashQuickStockBtn) dashQuickStockBtn.addEventListener('click', () => openStockModal(null, 'IN'));

  // Delegated table adjust buttons
  document.getElementById('inventory-tbody')?.addEventListener('click', e => {
    const btn = e.target.closest('.quick-stock-adjust-btn');
    if (btn) openStockModal(btn.dataset.id, 'IN');
  });

  // Stock In / Out Modal trigger with data-type attribute
  document.querySelectorAll('[data-bs-target="#stock-modal"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type || 'IN';
      openStockModal(null, type);
    });
  });

  const stockForm = document.getElementById('stock-form');
  if (stockForm) stockForm.addEventListener('submit', handleStockFormSubmit);

  const stockProductSelect = document.getElementById('stock-product-select');
  if (stockProductSelect) stockProductSelect.addEventListener('change', updateStockModalPreview);

  const stockQtyInput = document.getElementById('stock-qty-input');
  if (stockQtyInput) stockQtyInput.addEventListener('input', updateStockModalPreview);

  document.querySelectorAll('input[name="stockOpType"]').forEach(radio => {
    radio.addEventListener('change', updateStockModalPreview);
  });

  // Export Movements CSV
  const exportMovCsvBtn = document.getElementById('export-movements-csv-btn');
  if (exportMovCsvBtn) {
    exportMovCsvBtn.addEventListener('click', () => {
      const movements = CartKaroStore.getMovements();
      const rows = [
        ['Movement ID', 'Timestamp', 'Product Name', 'Barcode', 'Type', 'Quantity', 'Previous Stock', 'New Stock', 'Reason'],
        ...movements.map(m => [m.id, m.date, m.productName, m.barcode, m.type, m.quantity, m.previousStock, m.newStock, m.reason || ''])
      ];
      exportToCSV(`cartkaro-stock-movements-${new Date().toISOString().slice(0, 10)}.csv`, rows);
      showToast('Movement audit logs exported to CSV.');
    });
  }

  // 8. Barcode Scanner Events
  const barcodeForm = document.getElementById('barcode-scan-form');
  const barcodeInput = document.getElementById('barcode-input');
  if (barcodeForm) {
    barcodeForm.addEventListener('submit', e => {
      e.preventDefault();
      handleBarcodeLookup(barcodeInput.value);
    });
  }

  // Quick Barcode Pill clicks
  const samplePills = document.getElementById('sample-barcode-pills');
  if (samplePills) {
    samplePills.addEventListener('click', e => {
      const pill = e.target.closest('.sample-barcode-pill');
      if (pill) {
        barcodeInput.value = pill.dataset.code;
        handleBarcodeLookup(pill.dataset.code);
      }
    });
  }

  // Fast continuous scanner on POS View
  const posBarcodeInput = document.getElementById('pos-barcode-input');
  if (posBarcodeInput) {
    posBarcodeInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = posBarcodeInput.value.trim();
        if (!code) return;
        const products = CartKaroStore.getProducts();
        const product = products.find(p => p.barcode === code || p.id.toLowerCase() === code.toLowerCase());
        if (product) {
          addToCart(product.id);
          posBarcodeInput.value = '';
          showToast(`Scanned and added: "${product.name}"`);
        } else {
          showToast(`No product found for barcode "${code}"!`, true);
          SoundFx.alertTone();
        }
      }
    });
  }

  // 9. POS Billing Events
  const posSearchInput = document.getElementById('pos-search-input');
  if (posSearchInput) posSearchInput.addEventListener('input', renderPOSProductGrid);

  // Click on POS product card to add to cart
  const posGrid = document.getElementById('pos-products-grid');
  if (posGrid) {
    posGrid.addEventListener('click', e => {
      const card = e.target.closest('.pos-product-card');
      if (card && !card.classList.contains('out-of-stock')) {
        addToCart(card.dataset.id);
      }
    });
  }

  // Cart Table delegated clicks (+, -, trash, manual qty)
  const cartTbody = document.getElementById('pos-cart-tbody');
  if (cartTbody) {
    cartTbody.addEventListener('click', e => {
      const plusBtn = e.target.closest('.cart-plus-btn');
      if (plusBtn) {
        const item = AppState.cart.find(i => i.productId === plusBtn.dataset.id);
        if (item) updateCartQty(item.productId, item.quantity + 1);
        return;
      }

      const minusBtn = e.target.closest('.cart-minus-btn');
      if (minusBtn) {
        const item = AppState.cart.find(i => i.productId === minusBtn.dataset.id);
        if (item) updateCartQty(item.productId, item.quantity - 1);
        return;
      }

      const removeBtn = e.target.closest('.cart-remove-btn');
      if (removeBtn) {
        removeFromCart(removeBtn.dataset.id);
      }
    });

    cartTbody.addEventListener('change', e => {
      const qtyInput = e.target.closest('.cart-qty-input');
      if (qtyInput) {
        updateCartQty(qtyInput.dataset.id, qtyInput.value);
      }
    });
  }

  const clearCartBtn = document.getElementById('pos-clear-cart-btn');
  if (clearCartBtn) clearCartBtn.addEventListener('click', clearCart);

  // Recalculate bill on discount / gst / cash input change
  ['pos-discount-type', 'pos-discount-val', 'pos-gst-select', 'pos-cash-received'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const subtotal = AppState.cart.reduce((sum, i) => sum + i.amount, 0);
        calculatePOSBill(subtotal);
      });
    }
  });

  // Payment Mode toggle (Cash vs UPI vs Card views)
  document.querySelectorAll('input[name="paymentMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const val = radio.value;
      const cashDiv = document.getElementById('pos-cash-details');
      const upiDiv = document.getElementById('pos-upi-details');
      const cardDiv = document.getElementById('pos-card-details');

      if (val === 'Cash') {
        cashDiv.classList.remove('d-none');
        upiDiv.classList.add('d-none');
        cardDiv.classList.add('d-none');
      } else if (val === 'UPI') {
        cashDiv.classList.add('d-none');
        upiDiv.classList.remove('d-none');
        cardDiv.classList.add('d-none');
      } else if (val === 'Card') {
        cashDiv.classList.add('d-none');
        upiDiv.classList.add('d-none');
        cardDiv.classList.remove('d-none');
      }
    });
  });

  // Quick Cash Tender buttons
  document.querySelectorAll('.quick-cash-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const amt = parseFloat(btn.dataset.amt);
      const cashInput = document.getElementById('pos-cash-received');
      const cur = parseFloat(cashInput.value) || 0;
      cashInput.value = (cur + amt).toFixed(2);
      const subtotal = AppState.cart.reduce((sum, i) => sum + i.amount, 0);
      calculatePOSBill(subtotal);
    });
  });

  const exactCashBtn = document.getElementById('quick-cash-exact');
  if (exactCashBtn) {
    exactCashBtn.addEventListener('click', () => {
      const subtotal = AppState.cart.reduce((sum, i) => sum + i.amount, 0);
      const calc = calculatePOSBill(subtotal);
      document.getElementById('pos-cash-received').value = calc.grandTotal.toFixed(2);
      calculatePOSBill(subtotal);
    });
  }

  // POS Checkout Complete Bill
  const checkoutBtn = document.getElementById('pos-checkout-btn');
  if (checkoutBtn) checkoutBtn.addEventListener('click', handlePOSCheckout);

  // 10. Receipt Modal Action Buttons
  const printReceiptBtn = document.getElementById('btn-print-receipt');
  if (printReceiptBtn) {
    printReceiptBtn.addEventListener('click', () => {
      window.print();
    });
  }

  const newBillFromRcptBtn = document.getElementById('btn-new-bill-from-rcpt');
  if (newBillFromRcptBtn) {
    newBillFromRcptBtn.addEventListener('click', () => {
      bootstrap.Modal.getInstance(document.getElementById('receipt-modal')).hide();
      switchView('pos');
    });
  }

  // 11. Sales History Events
  ['sales-search-input', 'sales-date-filter', 'sales-payment-filter', 'sales-sort-filter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { AppState.salesPage = 1; renderSales(); });
  });

  const salesPagination = document.getElementById('sales-pagination');
  if (salesPagination) {
    salesPagination.addEventListener('click', e => {
      const btn = e.target.closest('.page-link');
      if (btn && btn.dataset.page) {
        AppState.salesPage = parseInt(btn.dataset.page, 10);
        renderSales();
      }
    });
  }

  // Delegated Sales table actions (View Receipt & Return/Void)
  document.getElementById('sales-tbody')?.addEventListener('click', e => {
    const viewBtn = e.target.closest('.view-bill-receipt-btn');
    if (viewBtn) {
      const bill = CartKaroStore.getBills().find(b => b.billNo === viewBtn.dataset.bill);
      if (bill) openReceiptModal(bill);
      return;
    }

    const voidBtn = e.target.closest('.void-bill-btn');
    if (voidBtn) {
      voidBill(voidBtn.dataset.bill);
    }
  });

  // Export Sales CSV
  const exportSalesCsvBtn = document.getElementById('export-sales-csv-btn');
  if (exportSalesCsvBtn) {
    exportSalesCsvBtn.addEventListener('click', () => {
      const bills = CartKaroStore.getBills();
      const rows = [
        ['Bill No', 'Date', 'Customer Name', 'Customer Phone', 'Payment Method', 'Items Count', 'Subtotal (INR)', 'Discount (INR)', 'GST (INR)', 'Grand Total (INR)', 'Status'],
        ...bills.map(b => [b.billNo, b.date, b.customerName || 'Walk-in', b.customerPhone || '', b.paymentMethod, b.items ? b.items.length : 0, b.subtotal, b.discountAmount, b.gstAmount, b.grandTotal, b.status || 'Completed'])
      ];
      exportToCSV(`cartkaro-sales-history-${new Date().toISOString().slice(0, 10)}.csv`, rows);
      showToast('Sales history exported to CSV.');
    });
  }

  // Export Reports CSV
  const exportReportsCsvBtn = document.getElementById('export-reports-csv-btn');
  if (exportReportsCsvBtn) {
    exportReportsCsvBtn.addEventListener('click', () => {
      const products = CartKaroStore.getProducts();
      const bills = CartKaroStore.getBills().filter(b => b.status === 'Completed');
      const rows = [
        ['Product ID', 'Name', 'Category', 'Current Stock', 'Cost Price', 'Selling Price', 'Inventory Cost Value', 'Inventory Retail Value'],
        ...products.map(p => [p.id, p.name, p.category, p.quantity, p.costPrice, p.sellingPrice, p.quantity * p.costPrice, p.quantity * p.sellingPrice])
      ];
      exportToCSV(`cartkaro-reports-analytics-${new Date().toISOString().slice(0, 10)}.csv`, rows);
      showToast('Analytics summary exported to CSV.');
    });
  }

  // 12. Settings & Backup Events
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) settingsForm.addEventListener('submit', handleSettingsSubmit);

  const exportBackupBtn = document.getElementById('export-backup-btn');
  if (exportBackupBtn) exportBackupBtn.addEventListener('click', exportDatabaseBackup);

  const importFileInput = document.getElementById('import-backup-file');
  if (importFileInput) {
    importFileInput.addEventListener('change', e => {
      importDatabaseBackup(e.target.files[0]);
    });
  }

  // Refresh from Supabase (replaces the old "reload demo data" action)
  const reloadDemoBtn = document.getElementById('reload-demo-data-btn');
  if (reloadDemoBtn) {
    reloadDemoBtn.addEventListener('click', async () => {
      const unlock = lockButton(reloadDemoBtn, '<span class="spinner-border spinner-border-sm me-1"></span> Refreshing...');
      const res = await CartKaroDB.refreshAll();
      unlock();
      if (res.ok) {
        showToast('Data refreshed from Supabase.');
        SoundFx.successChime();
      } else {
        showToast(`Refresh failed: ${res.error.message}`, true);
        SoundFx.alertTone();
      }
    });
  }

  // Clear local cache + settings (never touches the database)
  const resetAllBtn = document.getElementById('reset-all-data-btn');
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      openConfirmModal({
        title: 'Reset Local Settings?',
        message: 'This resets shop settings stored in this browser and reloads data from Supabase. Products, bills and stock in the database are NOT deleted.',
        iconClass: 'bi-arrow-counterclockwise',
        onConfirm: async () => {
          localStorage.removeItem(STORAGE_KEYS.SETTINGS);
          CartKaroStore.saveSettings({ ...DEFAULT_SETTINGS });
          AppState.cart = [];
          AppState.checkoutAttempt = null;
          showToast('Local settings reset. Reloading data from Supabase...');
          await CartKaroDB.refreshAll();
          renderSettings();
        }
      });
    });
  }

  applyDatabaseModeLabels();

  // 13. Supabase Client Initialization & Event Handlers
  SupabaseService.init();

  const testSbBtn = document.getElementById('btn-test-sb-connection');
  const sbTestOutput = document.getElementById('sb-query-test-output');
  if (testSbBtn && sbTestOutput) {
    testSbBtn.addEventListener('click', async () => {
      sbTestOutput.classList.remove('d-none');
      sbTestOutput.innerHTML = '<span class="text-info"><i class="bi bi-hourglass-split"></i> Querying public.products from Supabase...</span>';
      
      const res = await SupabaseService.fetchProducts();
      if (res.error) {
        sbTestOutput.innerHTML = `<span class="text-danger">Query Error:</span>\n${esc(JSON.stringify(res.error, null, 2))}`;
      } else if (res.isRlsRestricted) {
        sbTestOutput.innerHTML = `<span class="text-warning">RLS Restriction Detected:</span>\nQuery executed successfully (HTTP 200), but PostgreSQL Row Level Security returned 0 rows because you are not signed in. Sign in with a staff account.`;
      } else {
        sbTestOutput.innerHTML = `<span class="text-success">Success! Found ${res.data.length} products in Supabase:</span>\n${esc(JSON.stringify(res.data.slice(0, 3), null, 2))}`;
      }
    });
  }

  const sbLoginForm = document.getElementById('supabase-login-form');
  if (sbLoginForm) {
    sbLoginForm.addEventListener('submit', async e => {
      e.preventDefault();
      const email = document.getElementById('sb-login-email').value.trim();
      const password = document.getElementById('sb-login-password').value;

      if (!email || !password) {
        showToast('Please enter staff email and password', true);
        return;
      }

      showToast('Authenticating with Supabase...');
      const res = await SupabaseService.signIn(email, password);
      if (res.error) {
        showToast(`Login failed: ${res.error.message}`, true);
        SoundFx.alertTone();
      } else {
        showToast(`Signed in successfully as ${email}!`);
        SoundFx.successChime();
        await syncSupabaseData();
      }
    });
  }

  const sbLogoutBtn = document.getElementById('btn-sb-logout');
  if (sbLogoutBtn) {
    sbLogoutBtn.addEventListener('click', async () => {
      await SupabaseService.signOut();
      CartKaroStore.clearData();
      AppState.cart = [];
      AppState.lastSync = null;
      AppState.syncError = null;
      CartKaroDB.updateStorageLabel();
      CartKaroDB.rerender();
      showToast('Logged out from staff session.');
    });
  }

  // Load everything from Supabase (products, inventory, bills, stock movements)
  async function syncSupabaseData() {
    const res = await CartKaroDB.refreshAll();
    if (res.ok) {
      showToast(`Loaded ${CartKaroStore.getProducts().length} products and ${CartKaroStore.getBills().length} bills from Supabase.`);
    } else if (res.error && res.error.code === 'AUTH_REQUIRED') {
      showToast('Sign in with your staff account (Supabase badge, top bar) to load data.', true);
    } else {
      showToast(`Could not load data: ${res.error.message}`, true);
    }
    return res;
  }

  // Sign-out from another tab or an expired session: drop cached data
  if (SupabaseService.client) {
    SupabaseService.client.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') {
        SupabaseService.isAuthenticated = false;
        SupabaseService.currentUser = null;
        CartKaroStore.clearData();
        AppState.lastSync = null;
        SupabaseService.updateStatusBadge();
        CartKaroDB.updateStorageLabel();
        CartKaroDB.rerender();
      }
    });
  }

  // Initial load: restore session, then read live data
  (async () => {
    await SupabaseService.checkAuth();
    if (SupabaseService.isAuthenticated) {
      await syncSupabaseData();
    } else {
      CartKaroDB.updateStorageLabel();
      CartKaroDB.rerender();
      showToast('Sign in with your staff account (Supabase badge, top bar) to load data.', true);
    }
  })();

  // Initial Load: Route to hash or dashboard
  const initialHash = window.location.hash.replace('#', '') || 'dashboard';
  switchView(initialHash);
  AppState.cartBillNo = getNextBillNumber();
});

// Relabel the settings/footers that used to describe LocalStorage so the UI tells the truth.
function applyDatabaseModeLabels() {
  const setText = (el, text) => { if (el) el.textContent = text; };

  const reloadBtn = document.getElementById('reload-demo-data-btn');
  if (reloadBtn) {
    reloadBtn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i> Refresh Data from Supabase';
    const box = reloadBtn.parentElement;
    setText(box.querySelector('label'), 'Sync With Database');
    setText(box.querySelector('p'), 'Re-reads products, stock, bills and movements from Supabase.');
  }

  const resetBtn = document.getElementById('reset-all-data-btn');
  if (resetBtn) {
    resetBtn.innerHTML = '<i class="bi bi-arrow-counterclockwise me-1"></i> Reset Local Settings';
    const box = resetBtn.parentElement;
    setText(box.querySelector('label'), 'Reset Local Settings');
    setText(box.querySelector('p'), 'Resets shop settings saved in this browser. Database records are never deleted from here.');
  }

  const exportBtn = document.getElementById('export-backup-btn');
  if (exportBtn) {
    const desc = exportBtn.closest('.card-body') && exportBtn.closest('.card-body').querySelector('p');
    setText(desc, 'Products, bills and stock live in Supabase. This export downloads a JSON snapshot of what is currently loaded.');
  }

  const importInput = document.getElementById('import-backup-file');
  if (importInput && importInput.closest('label')) importInput.closest('label').classList.add('d-none');

  CartKaroDB.updateStorageLabel();
}
