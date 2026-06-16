import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getUserIdFromRequest } from "@/lib/jwt";
import { getOrderById, getOrders, deliverDigitalGoods, updateStocks } from "@/lib/yandex";

// Ручная отправка товара (один заказ или все PROCESSING)
export async function POST(request: NextRequest) {
  try {
    const userId = getUserIdFromRequest(request);
    const { shop_id, order_id_ym } = await request.json();

    if (!shop_id) {
      return NextResponse.json({ error: "shop_id required" }, { status: 400 });
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

    // Если order_id_ym не передан — сканируем все PROCESSING заказы
    if (!order_id_ym) {
      const ordersData = await getOrders(shop.api_key, shop.business_id, {
        statuses: ["PROCESSING"],
        campaignIds: [shop.campaign_id],
        limit: 20,
      });

      const processingOrders = ordersData.orders || [];
      const results: string[] = [];
      let totalSent = 0;

      for (const ymOrder of processingOrders) {
        const ymOrderId = String(ymOrder.id || ymOrder.orderId);
        const ymOrderIdNum = ymOrder.id || ymOrder.orderId || 0;

        if (!ymOrderIdNum) {
          results.push(`SKIP: order without id`);
          continue;
        }

        // Пропускаем уже обработанные
        const { data: existing } = await supabaseAdmin
          .from("orders")
          .select("id")
          .eq("order_id_ym", ymOrderId)
          .eq("shop_id", shop_id)
          .single();

        if (existing) {
          results.push(`${ymOrderId}: уже в базе`);
          continue;
        }

        // Создаём запись заказа
        const { data: orderRecord } = await supabaseAdmin
          .from("orders")
          .insert({
            shop_id: shop.id,
            order_id_ym: ymOrderId,
            buyer_email: ymOrder.buyer?.email || "",
            total_keys: 0,
            status: "PROCESSING",
          })
          .select()
          .single();

        if (!orderRecord) {
          results.push(`${ymOrderId}: ошибка создания`);
          continue;
        }

        const itemsToDeliver: { id: number; codes: string[]; slip: string; activateTill: string }[] = [];
        let orderKeys = 0;

        for (const item of ymOrder.items || []) {
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

          await supabaseAdmin
            .from("keys")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .in("id", keyIds);

          itemsToDeliver.push({ id: item.id, codes, slip: product.instruction || "", activateTill: new Date(Date.now() + 30 * 86400 * 1000).toISOString() });

          for (const keyId of keyIds) {
            await supabaseAdmin.from("order_items").insert({
              order_id: orderRecord.id,
              key_id: keyId,
              code: availableKeys.find((k) => k.id === keyId)?.code || "",
            });
          }

          orderKeys += codes.length;

          const { count: remainingCount } = await supabaseAdmin
            .from("keys")
            .select("*", { count: "exact", head: true })
            .eq("product_id", product.id)
            .eq("status", "available");

          if (remainingCount === 0) {
            await updateStocks(shop.api_key, shop.business_id, shop.campaign_id, offerId, 0)
              .catch(() => {});
          }
        }

        await supabaseAdmin
          .from("orders")
          .update({ total_keys: orderKeys })
          .eq("id", orderRecord.id);

        if (itemsToDeliver.length > 0) {
          try {
            await deliverDigitalGoods(shop.api_key, shop.business_id, shop.campaign_id, ymOrderIdNum, itemsToDeliver);
            results.push(`${ymOrderId}: отправлено ${orderKeys} ключей`);
            totalSent += orderKeys;
          } catch (e: any) {
            results.push(`${ymOrderId}: ошибка API - ${e.message}`);
          }
        } else {
          results.push(`${ymOrderId}: нет доступных ключей`);
        }
      }

      return NextResponse.json({ status: "ok", total_sent: totalSent, orders: results });
    }

    // Одиночная отправка
    const { data: orderRecord } = await supabaseAdmin
      .from("orders")
      .select("*")
      .eq("order_id_ym", order_id_ym)
      .eq("shop_id", shop_id)
      .single();

    if (!orderRecord) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const { data: existingItems } = await supabaseAdmin
      .from("order_items")
      .select("id")
      .eq("order_id", orderRecord.id)
      .limit(1);

    if (existingItems && existingItems.length > 0) {
      return NextResponse.json({ error: "Order already delivered" }, { status: 409 });
    }

    const fullOrder = await getOrderById(shop.api_key, shop.business_id, shop.campaign_id, Number(order_id_ym));
    if (!fullOrder) {
      return NextResponse.json({ error: "Order not found in Yandex API. Check order ID." }, { status: 404 });
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

      await supabaseAdmin
        .from("keys")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .in("id", keyIds);

      itemsToDeliver.push({ id: item.id, codes, slip: product.instruction || "", activateTill: new Date(Date.now() + 30 * 86400 * 1000).toISOString() });

      for (const keyId of keyIds) {
        await supabaseAdmin.from("order_items").insert({
          order_id: orderRecord.id,
          key_id: keyId,
          code: availableKeys.find((k) => k.id === keyId)?.code || "",
        });
      }

      totalKeys += codes.length;

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