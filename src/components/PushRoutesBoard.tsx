"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Checkbox, MultiSelect, Switch, Text, TextInput } from "@mantine/core";

import { Card } from "@/components/Card";
import {
  expandTelegramChats,
  PUSH_KIND_META,
  PUSH_KINDS,
  type DiscordHookRow,
  type PushKind,
  type PushRoute,
} from "@/lib/notifications/pushRoutesLogic";

type TelegramGroup = { id: string; title: string; subscribed: boolean };
type BoardRoute = PushRoute & { discordHooks: DiscordHookRow[] };
type BoardRoutes = Record<PushKind, BoardRoute>;

type Payload = {
  updatedAt: string;
  routes: BoardRoutes;
  telegram: { ok: boolean; username?: string; groups: TelegramGroup[] };
};

function copyRoutes(routes: BoardRoutes): BoardRoutes {
  return Object.fromEntries(PUSH_KINDS.map((kind) => {
    const row = routes[kind];
    return [kind, {
      ...row,
      discordDests: [...row.discordDests],
      discordWebhooks: [...row.discordWebhooks],
      discordHooks: row.discordHooks.map((hook) => ({ ...hook })),
      telegramChats: [...row.telegramChats],
    }];
  })) as BoardRoutes;
}

function DiscordWebhooksField({
  value,
  disabled,
  onChange,
}: {
  value: DiscordHookRow[];
  disabled: boolean;
  onChange: (value: DiscordHookRow[]) => void;
}) {
  const rows = value.length ? value : [{ label: "自定义", url: "" }];
  return (
    <div className="min-w-[28rem] space-y-2">
      {rows.map((hook, index) => (
        <div key={`${hook.label}-${index}`} className="flex items-end gap-1">
          <TextInput
            size="xs"
            className="flex-1"
            label={hook.label}
            value={hook.url}
            placeholder="粘贴 webhook"
            disabled={disabled}
            onChange={(event) => {
              const next = rows.map((item, i) => (i === index ? { ...item, url: event.currentTarget.value } : item));
              onChange(next);
            }}
          />
          {rows.length > 1 ? (
            <Button size="compact-xs" variant="subtle" color="gray" disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              删
            </Button>
          ) : null}
        </div>
      ))}
      <Button size="compact-xs" variant="subtle" disabled={disabled} onClick={() => onChange([...rows, { label: "自定义", url: "" }])}>
        添加 webhook
      </Button>
    </div>
  );
}

export function PushRoutesBoard() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<BoardRoutes | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/push-routes", { cache: "no-store" });
    const json = (await res.json()) as Payload & { error?: string };
    if (!res.ok) throw new Error(json.error || "读取失败");
    setPayload(json);
    setDraft(copyRoutes(json.routes));
    setError("");
  }, []);

  useEffect(() => {
    load().catch((err: unknown) => setError(err instanceof Error ? err.message : "读取失败"));
  }, [load]);

  const dirty = Boolean(payload && draft && JSON.stringify(draft) !== JSON.stringify(payload.routes));

  async function save() {
    if (!payload || !draft) return;
    setSaving(true);
    try {
      const res = await fetch("/api/push-routes", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routes: draft, updatedAt: payload.updatedAt }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || "保存失败");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function patch(kind: PushKind, next: Partial<BoardRoute>) {
    if (!draft) return;
    setDraft({ ...draft, [kind]: { ...draft[kind], ...next } });
  }

  const telegramOptions = (payload?.telegram.groups ?? []).map((group) => ({
    value: group.id,
    label: group.subscribed ? group.title || group.id : `${group.title || group.id}（未订阅）`,
    disabled: !group.subscribed,
  }));

  return (
    <Card lift={false}>
      {error ? (
        <Alert color="red" mb="md" variant="light">
          {error}
        </Alert>
      ) : null}
      <Text size="sm" c="dimmed" mb="md">
        Discord webhook 存在后端，打开页面会把现用推送地址写成默认值。改完保存即生效。第一个为主频道，后面的抄送失败不挡主频道。Telegram：在每个要收的话题里 /resume，然后在这里按话题勾选。同一话题群可以拆到不同信号。/pause 停全群。
      </Text>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>信息</th>
              <th>推送</th>
              <th>Discord</th>
              <th>Discord webhook</th>
              <th>Telegram</th>
              <th>Telegram 话题</th>
            </tr>
          </thead>
          <tbody>
            {PUSH_KINDS.map((kind) => {
              const row = draft?.[kind];
              if (!row) return null;
              return (
                <tr key={kind}>
                  <td>
                    <div className="font-medium text-zinc-100">{PUSH_KIND_META[kind].label}</div>
                    <div className="text-xs text-zinc-500">{PUSH_KIND_META[kind].hint}</div>
                  </td>
                  <td>
                    <Switch size="sm" checked={row.enabled} onChange={(event) => patch(kind, { enabled: event.currentTarget.checked })} />
                  </td>
                  <td>
                    <Checkbox
                      size="sm"
                      checked={row.discord}
                      disabled={!row.enabled}
                      onChange={(event) => patch(kind, { discord: event.currentTarget.checked })}
                    />
                  </td>
                  <td>
                    <DiscordWebhooksField
                      value={row.discordHooks}
                      disabled={!row.enabled || !row.discord}
                      onChange={(discordHooks) => patch(kind, { discordHooks, discordWebhooks: discordHooks.map((hook) => hook.url) })}
                    />
                  </td>
                  <td>
                    <Checkbox
                      size="sm"
                      checked={row.telegram}
                      disabled={!row.enabled}
                      onChange={(event) => patch(kind, { telegram: event.currentTarget.checked })}
                    />
                  </td>
                  <td className="min-w-56">
                    <div className="space-y-2">
                      <Checkbox
                        size="xs"
                        label="全部已订阅"
                        checked={row.telegramAll}
                        disabled={!row.enabled || !row.telegram}
                        onChange={(event) => patch(kind, { telegramAll: event.currentTarget.checked })}
                      />
                      {row.telegram && !row.telegramAll ? (
                        telegramOptions.length ? (
                          <MultiSelect
                            size="xs"
                            data={telegramOptions}
                            value={expandTelegramChats(row.telegramChats, telegramOptions.map((item) => item.value))}
                            disabled={!row.enabled}
                            onChange={(value) => patch(kind, { telegramChats: value })}
                          />
                        ) : (
                          <Text size="xs" c="dimmed">
                            还没有已订阅话题
                          </Text>
                        )
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <Text size="xs" c="dimmed">
          {payload?.telegram.ok
            ? `Telegram @${payload.telegram.username || "bot"} · ${payload.telegram.groups.filter((g) => g.subscribed).length} 个接收位置`
            : "Telegram 中转未连上，开关仍可保存，话题列表暂空"}
        </Text>
        <Button size="sm" disabled={!dirty || saving} loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Card>
  );
}
