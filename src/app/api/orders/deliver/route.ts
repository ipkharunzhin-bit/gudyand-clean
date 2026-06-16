import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserIdFromRequest } from "@/lib/jwt";
import { getOrders, deliverDigitalGoods, updateStocks } from "@/lib/yandex";

// Ручная отправка товара
export async function POST(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const { shop_id, order_id_ym } = await request.json();

    if (!shop_id || !order_id_ym) {
      return NextResponse.json({ error: "shop_id and order_id_ym required" }, { status: 400 });
    }

    // Проверяем магазин
    const { data: shop } = await supabaseAdmin
      .from("shops")
      .select("*")
      .eq("id", shop_id)
      .eq("user_id", userId)
      .single();

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    // Проверяем заказ
    const { data: orderRecord } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("order_id_ym", order_id_ym)
      .eq("shop_id", shop_id)
      .single();

    if (!orderRecord) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Если уже отправлен — нельзя повторно
    const { data: existingItems } = await supabaseAdmin
      .from("order_items")
      .select("id")
      .eq("order_id", orderRecord.id)
      .limit(1);

    if (existingItems && existingItems.length > 0) {
      return NextResponse.json({ error: "Order already delivered" }, { status: 409 });
    }

    // Получаем детали заказа из Яндекса
    const ordersData = await getOrders(shop.api_key, shop.business_id, {
      statuses: ["PROCESSING"],
      campaignIds: [shop.campaign_id],
      limit: 10,
    });

    const fullOrder = ordersData.orders?.find((o) => String(o.id) === order_id_ym);
    if (!fullOrder) {
      return NextResponse.json({ error: "Order not found in Yandex API. Check order status." }, { status: 404 });
    }

    const itemsToDeliver: { id: number; codes: string[]; slip: string; activateTill: string }[] = [];
    let totalKeys = 0;

    for (const item of fullOrder.items) {
      const offerId = item.offerId;
      const count = item.count;

      const { data: product } = await supabaseAdmin
        .from("products")
        .select("id, instruction")
        .eq("shop_id", shop.id)
        .eq("offer_id", offerId)
        .single();

      if (!product) continue;

      const { data: availableKeys } = await supabaseAdmin
        .from("keys")
        .select("id, code")
        .eq("product_id", product.id)
        .eq("status", "available")
        .limit(count);

      if (!availableKeys || availableKeys.length < count) continue;

      const codes = availableKeys.map((k) => k.code);
      const keyIds = availableKeys.map((k) => k.id);

      // Отмечаем ключи как отправленные
      await supabaseAdmin
        .from("keys")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .in("id", keyIds);

      itemsToDeliver.push({ id: item.id, codes, slip: product.instruction || "", activateTill: new Date(Date.now() + 30 * 86400 * 1000).toISOString() });

      // Сохраняем связки ключ-заказ
      for (const keyId of keyIds) {
        await supabaseAdmin.from("order_items").insert({
          order_id: orderRecord.id,
          key_id: keyId,
          code: availableKeys.find((k) => k.id === keyId)?.code || "",
        });
      }

      totalKeys += codes.length;

      // Проверяем остатки и обновляем если закончились
      const { count: remainingCount } = await supabaseAdmin
        .from("keys")
        .select("*", { count: "exact", head: true })
        .eq("product_id", product.id)
        .eq("status", "available");

      if (remainingCount === 0) {
        await updateStocks(shop.api_key, shop.business_id, shop.campaign_id, offerId, 0)
          .catch((err) => console.error("Failed to update stocks:", err));
      }
    }

    // Обновляем total_keys
    await supabaseAdmin
      .from("orders")
      .update({ total_keys: totalKeys })
      .eq("id", orderRecord.id);

    if (itemsToDeliver.length > 0) {
      await deliverDigitalGoods(
        shop.api_key,
        shop.business_id,
        shop.campaign_id,
        Number(order_id_ym),
        itemsToDeliver
      );
    }

    return NextResponse.json({ status: "ok", delivered: itemsToDeliver.length, totalKeys });
  } catch (err: any) {
    console.error("Manual deliver error:", err?.message || err);
    return NextResponse.json({ error: err?.message || "Internal error" }, { status: 500 });
  }
}