/**
 * SeraPay Menu API Routes
 * Registered under /api/ in server/_core/index.ts
 */
import { Router } from "express";
import { createMenuOrder, getDb } from "./db";
import { menus, menuItems, merchants, type MenuItem } from "../drizzle/schema";
import { eq, and, asc, lte, or, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { requireApiKey } from "./payment-routes";
import { storagePut } from "./storage";

export const menuRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

async function ensureUniqueSlug(base: string, excludeId?: string): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  let slug = slugify(base) || "menu";
  let attempt = 0;
  while (true) {
    const suffix = uuidv4().replace(/-/g, "").slice(0, 6);
    const candidate = `${slug.slice(0, 72)}-${suffix}`;
    const existing = await db.select({ id: menus.id }).from(menus).where(eq(menus.slug, candidate));
    if (existing.length === 0 || (excludeId && existing[0].id === excludeId)) return candidate;
    attempt++;
  }
}

function normalizeBusinessCategory(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 80) : null;
}

function normalizeCategoryOther(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 120) : null;
}

function normalizeSoldOutUntil(value: unknown) {
  if (value === null || value === false || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return null;
  return date.getTime() > Date.now() ? date : null;
}

async function clearExpiredSoldOutItems(db: any, menuId?: string) {
  const expired = lte(menuItems.soldOutUntil, new Date());
  await db.update(menuItems)
    .set({ soldOutUntil: null })
    .where(menuId ? and(eq(menuItems.menuId, menuId), expired) : expired);
}

function availableMenuItemWhere(menuId: string) {
  return and(
    eq(menuItems.menuId, menuId),
    eq(menuItems.isActive, 1),
    or(isNull(menuItems.soldOutUntil), lte(menuItems.soldOutUntil, new Date()))
  );
}

// ── Protected routes (require API key) ───────────────────────────────────────

/** GET /api/menus — list all menus for the authenticated merchant */
menuRouter.get("/menus", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const rows = await db.select().from(menus).where(eq(menus.merchantId, merchant.id)).orderBy(asc(menus.createdAt));
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/menus — create a new menu */
menuRouter.post("/menus", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { name, description, businessCategory, businessCategoryOther } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 1 || name.length > 120) {
      res.status(400).json({ error: "Menu name is required (max 120 chars)" }); return;
    }
    const slug = await ensureUniqueSlug(name.trim());
    const id = uuidv4();
    await db.insert(menus).values({
      id,
      merchantId: merchant.id,
      name: name.trim(),
      description: description?.trim()?.slice(0, 500) || null,
      businessCategory: normalizeBusinessCategory(businessCategory),
      businessCategoryOther: normalizeCategoryOther(businessCategoryOther),
      slug,
      isActive: 1,
    });
    const [created] = await db.select().from(menus).where(eq(menus.id, id));
    res.status(201).json(created);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** PUT /api/menus/:menuId — update a menu */
menuRouter.put("/menus/:menuId", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    const { name, description, isActive, businessCategory, businessCategoryOther } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length < 1 || name.length > 120) { res.status(400).json({ error: "Invalid name" }); return; }
      updates.name = name.trim();
      if (name.trim() !== menu.name) updates.slug = await ensureUniqueSlug(name.trim(), menuId);
    }
    if (description !== undefined) updates.description = description?.trim()?.slice(0, 500) || null;
    if (businessCategory !== undefined) updates.businessCategory = normalizeBusinessCategory(businessCategory);
    if (businessCategoryOther !== undefined) updates.businessCategoryOther = normalizeCategoryOther(businessCategoryOther);
    if (isActive !== undefined) updates.isActive = isActive ? 1 : 0;
    await db.update(menus).set(updates).where(eq(menus.id, menuId));
    const [updated] = await db.select().from(menus).where(eq(menus.id, menuId));
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** DELETE /api/menus/:menuId — delete a menu and its items */
menuRouter.delete("/menus/:menuId", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    await db.delete(menuItems).where(eq(menuItems.menuId, menuId));
    await db.delete(menus).where(eq(menus.id, menuId));
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** GET /api/menus/:menuId/items — list items for a menu */
menuRouter.get("/menus/:menuId/items", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    await clearExpiredSoldOutItems(db, menuId);
    const items = await db.select().from(menuItems).where(eq(menuItems.menuId, menuId)).orderBy(asc(menuItems.sortOrder), asc(menuItems.createdAt));
    res.json(items);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/menus/:menuId/items — add an item to a menu */
menuRouter.post("/menus/:menuId/items", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    const { name, description, price, coin, imageUrl, sortOrder, category } = req.body;
    if (!name || typeof name !== "string" || name.trim().length < 1) { res.status(400).json({ error: "Item name is required" }); return; }
    const priceNum = parseFloat(price);
    if (isNaN(priceNum) || priceNum < 0) { res.status(400).json({ error: "Invalid price" }); return; }
    const id = uuidv4();
    await db.insert(menuItems).values({
      id,
      menuId,
      name: name.trim(),
      description: description?.trim()?.slice(0, 500) || null,
      price: priceNum.toString(),
      coin: coin?.slice(0, 20) || "USDC",
      imageUrl: imageUrl?.slice(0, 512) || null,
      category: category?.trim()?.slice(0, 60) || null,
      sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
      isActive: 1,
      soldOutUntil: null,
    });
    const [created] = await db.select().from(menuItems).where(eq(menuItems.id, id));
    res.status(201).json(created);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** PUT /api/menus/:menuId/items/:itemId — update a menu item */
menuRouter.put("/menus/:menuId/items/:itemId", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId, itemId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    const [item] = await db.select().from(menuItems).where(and(eq(menuItems.id, itemId), eq(menuItems.menuId, menuId)));
    if (!item) { res.status(404).json({ error: "Item not found" }); return; }
    const { name, description, price, coin, imageUrl, sortOrder, isActive, category, soldOutUntil } = req.body;
    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name.trim().slice(0, 120);
    if (description !== undefined) updates.description = description?.trim()?.slice(0, 500) || null;
    if (price !== undefined) {
      const p = parseFloat(price);
      if (isNaN(p) || p < 0) { res.status(400).json({ error: "Invalid price" }); return; }
      updates.price = p.toString();
    }
    if (coin !== undefined) updates.coin = coin?.slice(0, 20) || "USDC";
    if (imageUrl !== undefined) updates.imageUrl = imageUrl?.slice(0, 512) || null;
    if (category !== undefined) updates.category = category?.trim()?.slice(0, 60) || null;
    if (sortOrder !== undefined) updates.sortOrder = typeof sortOrder === "number" ? sortOrder : 0;
    if (isActive !== undefined) updates.isActive = isActive ? 1 : 0;
    if (soldOutUntil !== undefined) updates.soldOutUntil = normalizeSoldOutUntil(soldOutUntil);
    await db.update(menuItems).set(updates).where(eq(menuItems.id, itemId));
    const [updated] = await db.select().from(menuItems).where(eq(menuItems.id, itemId));
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** DELETE /api/menus/:menuId/items/:itemId — delete a menu item */
menuRouter.delete("/menus/:menuId/items/:itemId", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId, itemId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    await db.delete(menuItems).where(and(eq(menuItems.id, itemId), eq(menuItems.menuId, menuId)));
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** PATCH /api/menus/:menuId/items/coin — bulk-update all items in a menu to a new coin */
menuRouter.patch("/menus/:menuId/items/coin", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    const { coin, rate } = req.body;
    if (!coin || typeof coin !== "string") { res.status(400).json({ error: "coin required" }); return; }
    const targetCoin = coin.slice(0, 20).toUpperCase();
    const conversionRate = Number(rate);
    if (Number.isFinite(conversionRate) && conversionRate > 0) {
      const items = await db.select().from(menuItems).where(eq(menuItems.menuId, menuId));
      await Promise.all(items.map((item: any) => {
        const nextPrice = (Number(item.price) * conversionRate).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00");
        return db.update(menuItems).set({ coin: targetCoin, price: nextPrice }).where(eq(menuItems.id, item.id));
      }));
      res.json({ success: true, coin: targetCoin, converted: true, rate: conversionRate });
      return;
    }
    await db.update(menuItems).set({ coin: targetCoin }).where(eq(menuItems.menuId, menuId));
    res.json({ success: true, coin: targetCoin, converted: false });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/menus/:menuId/items/batch — create multiple items at once (used by template flow) */
menuRouter.post("/menus/:menuId/items/batch", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) { res.status(400).json({ error: "items array required" }); return; }
    const rows = items.slice(0, 50).map((item: any, idx: number) => ({
      id: uuidv4(),
      menuId,
      name: String(item.name || "").trim().slice(0, 200),
      description: item.description ? String(item.description).trim().slice(0, 500) : null,
      price: String(parseFloat(item.price) || 0),
      coin: String(item.coin || "USDC").slice(0, 20),
      imageUrl: null as string | null,
      category: item.category ? String(item.category).trim().slice(0, 60) : null,
      sortOrder: idx,
      isActive: 1 as const,
      soldOutUntil: null,
    }));
    if (rows.length > 0) await db.insert(menuItems).values(rows);
    const created = await db.select().from(menuItems).where(eq(menuItems.menuId, menuId)).orderBy(asc(menuItems.sortOrder), asc(menuItems.createdAt));
    res.status(201).json(created);
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/menus/:menuId/items/:itemId/image — upload item photo */
menuRouter.post("/menus/:menuId/items/:itemId/image", requireApiKey as any, async (req: any, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const merchant = req.merchant;
    const { menuId, itemId } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.merchantId, merchant.id)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    const [item] = await db.select().from(menuItems).where(and(eq(menuItems.id, itemId), eq(menuItems.menuId, menuId)));
    if (!item) { res.status(404).json({ error: "Item not found" }); return; }

    const { imageData } = req.body; // base64 data URI
    if (!imageData || typeof imageData !== "string") { res.status(400).json({ error: "imageData required" }); return; }
    const match = imageData.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
    if (!match) { res.status(400).json({ error: "Invalid image format. Use JPEG, PNG, WebP, or GIF." }); return; }
    const mimeType = match[1] as string;
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length > 10 * 1024 * 1024) { res.status(400).json({ error: "Image too large (max 10MB)" }); return; }

    const ext = mimeType.split("/")[1].replace("jpeg", "jpg");
    const fileKey = `menu-items/${merchant.id}/${itemId}-${Date.now()}.${ext}`;
    const { url } = await storagePut(fileKey, buffer, mimeType);

    await db.update(menuItems).set({ imageUrl: url }).where(eq(menuItems.id, itemId));
    res.json({ imageUrl: url });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

// ── Public routes (no auth required) ─────────────────────────────────────────

/** GET /api/public/menu/:slug — public menu page data */
menuRouter.get("/public/menu/:slug", async (req, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const { slug } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.slug, slug), eq(menus.isActive, 1)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    await clearExpiredSoldOutItems(db, menu.id);
    const [merchant] = await db.select({
      name: merchants.name,
      logoData: merchants.logoData,
      walletAddress: merchants.walletAddress,
      storeAddress: merchants.storeAddress,
      receiveCoin: merchants.receiveCoin,
    }).from(merchants).where(eq(merchants.id, menu.merchantId));
    if (!merchant) { res.status(404).json({ error: "Merchant not found" }); return; }
    const items = await db.select().from(menuItems)
      .where(and(eq(menuItems.menuId, menu.id), eq(menuItems.isActive, 1)))
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.createdAt));
    res.json({
      menu,
      merchant: {
        ...merchant,
        walletAddress: merchant.storeAddress || merchant.walletAddress,
        ownerWalletAddress: merchant.walletAddress,
      },
      items,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});

/** POST /api/public/menu/:slug/orders — create an order before checkout */
menuRouter.post("/public/menu/:slug/orders", async (req, res) => {
  try {
    const db = await getDb();
    if (!db) { res.status(503).json({ error: "Database unavailable" }); return; }
    const { slug } = req.params;
    const [menu] = await db.select().from(menus).where(and(eq(menus.slug, slug), eq(menus.isActive, 1)));
    if (!menu) { res.status(404).json({ error: "Menu not found" }); return; }
    await clearExpiredSoldOutItems(db, menu.id);
    const [merchant] = await db.select({ receiveCoin: merchants.receiveCoin }).from(merchants).where(eq(merchants.id, menu.merchantId));

    const pax = Math.max(1, Math.min(99, Number.parseInt(String(req.body?.pax ?? "1"), 10) || 1));
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (requestedItems.length === 0) { res.status(400).json({ error: "items array required" }); return; }

    const availableItems = await db.select().from(menuItems)
      .where(availableMenuItemWhere(menu.id))
      .orderBy(asc(menuItems.sortOrder), asc(menuItems.createdAt)) as MenuItem[];
    const itemById = new Map(availableItems.map((item: any) => [item.id, item]));

    const requestedRows = requestedItems.slice(0, 80).map((entry: any) => {
      const id = String(entry?.id ?? "");
      const qty = Math.max(0, Math.min(99, Number.parseInt(String(entry?.qty ?? "0"), 10) || 0));
      return qty > 0 ? { id, qty } : null;
    }).filter(Boolean) as { id: string; qty: number }[];

    if (requestedRows.some((entry) => !itemById.has(entry.id))) {
      res.status(409).json({ error: "Some selected items are sold out or unavailable. Please refresh your order." }); return;
    }

    const rows = requestedRows.map((entry) => ({ item: itemById.get(entry.id)!, qty: entry.qty })) as { item: MenuItem; qty: number }[];

    if (rows.length === 0) { res.status(400).json({ error: "No valid menu items selected" }); return; }
    const firstCoin = rows[0].item.coin || "USDC";
    const hasMixedCoins = rows.some((row) => (row.item.coin || "USDC") !== firstCoin);
    const orderCoin = hasMixedCoins ? "MIXED" : firstCoin;

    const orderItems = rows.map(({ item, qty }) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      coin: item.coin,
      category: item.category || "Uncategorised",
      qty,
      lineTotal: (Number(item.price) * qty).toFixed(6),
    }));
    const total = orderItems.reduce((sum, item) => sum + Number(item.lineTotal), 0);
    const categoryTotals = new Map<string, { name: string; quantity: number; amount: number }>();
    for (const item of orderItems) {
      const category = item.category || "Uncategorised";
      const current = categoryTotals.get(category) || { name: category, quantity: 0, amount: 0 };
      current.quantity += item.qty;
      current.amount += Number(item.lineTotal);
      categoryTotals.set(category, current);
    }
    const categoryColumns = Array.from(categoryTotals.values()).slice(0, 6).map((entry) => JSON.stringify({
      name: entry.name,
      quantity: entry.quantity,
      amount: entry.amount.toFixed(6),
      coin: orderCoin,
    }));

    const orderId = uuidv4();
    const resolvedBusinessCategory = menu.businessCategory === "Others"
      ? (menu.businessCategoryOther || "Others")
      : (menu.businessCategory || menu.businessCategoryOther || null);
    await createMenuOrder({
      id: orderId,
      merchantId: menu.merchantId,
      menuId: menu.id,
      status: "created",
      pax,
      businessCategory: resolvedBusinessCategory,
      category1: categoryColumns[0] || null,
      category2: categoryColumns[1] || null,
      category3: categoryColumns[2] || null,
      category4: categoryColumns[3] || null,
      category5: categoryColumns[4] || null,
      category6: categoryColumns[5] || null,
      items: JSON.stringify(orderItems),
      amount: total.toFixed(6),
      coin: orderCoin,
      orderedAt: new Date(),
    });

    res.status(201).json({
      id: orderId,
      menuId: menu.id,
      merchantId: menu.merchantId,
      pax,
      amount: total.toFixed(6),
      coin: hasMixedCoins ? (merchant?.receiveCoin || firstCoin) : firstCoin,
      items: orderItems,
      status: "created",
    });
  } catch (e) { console.error(e); res.status(500).json({ error: "Internal server error" }); }
});
