"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Order } from "@/types";
import { ArrowLeft, ShoppingBag, Search, Send } from "lucide-react";

export default function OrdersPage() {
  const { shopId } = useParams<{ shopId: string }>();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [delivering, setDelivering] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }
    loadOrders();
  }, [shopId]);

  async function loadOrders() {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(`/api/orders?shop_id=${shopId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOrders(data.orders || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  async function handleDeliver(orderIdYm: string) {
    if (!confirm(`Отправить ключи для заказа #${orderIdYm}?`)) return;
    setDelivering(orderIdYm);
    setError("");
    setSuccess("");
    try {
      const token = localStorage.getItem("token");
      const res = await fetch("/api/orders/deliver", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ shop_id: shopId, order_id_ym: orderIdYm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Ошибка отправки");
      setSuccess(`Заказ #${orderIdYm} отправлен! Ключей: ${data.totalKeys}`);
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setDelivering(null);
    }
  }

  const filteredOrders = orders.filter(
    (o) =>
      o.order_id_ym.toLowerCase().includes(search.toLowerCase()) ||
      o.buyer_email.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Загрузка...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-100">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link
              href={`/dashboard/${shopId}`}
              className="text-gray-400 hover:text-black transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-lg font-bold">История заказов</h1>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-8">
        {error && (
          <p className="mb-4 text-sm text-red-600 bg-red-50 rounded-lg p-3">
            {error}
          </p>
        )}
        {success && (
          <p className="mb-4 text-sm text-green-600 bg-green-50 rounded-lg p-3">
            {success}
          </p>
        )}

        <div className="card mb-6">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-field pl-10"
              placeholder="Поиск по ID заказа или email покупателя..."
            />
          </div>
        </div>

        {filteredOrders.length === 0 ? (
          <div className="text-center py-16">
            <ShoppingBag className="mx-auto h-12 w-12 text-gray-300" />
            <p className="mt-4 text-sm text-gray-500">
              {orders.length === 0
                ? "Заказов пока нет. Они появятся после первой автоматической отправки."
                : "Ничего не найдено"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredOrders.map((order) => (
              <div
                key={order.id}
                className="card flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div>
                  <p className="font-medium text-sm">
                    Заказ #{order.order_id_ym}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {order.buyer_email}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-gray-500">
                    {order.total_keys} ключей
                  </span>
                  {order.total_keys > 0 ? (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                      Отправлен
                    </span>
                  ) : (
                    <button
                      onClick={() => handleDeliver(order.order_id_ym)}
                      disabled={delivering === order.order_id_ym}
                      className="btn btn-sm flex items-center gap-1"
                    >
                      {delivering === order.order_id_ym ? (
                        "Отправка..."
                      ) : (
                        <>
                          <Send className="h-3.5 w-3.5" />
                          Отправить
                        </>
                      )}
                    </button>
                  )}
                  <span className="text-xs text-gray-400">
                    {new Date(order.created_at).toLocaleDateString(
                      "ru-RU",
                      {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      }
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}