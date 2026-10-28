"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_LABELS, type UserRole } from "@/lib/auth";

// 账号管理（T15，UIUX P9）：用户列表、[＋新建账号]、[重置密码]、[停用/启用]。
// 初始密码一次性弹窗展示+复制，关闭后不再显示（服务端也只返回这一次）；
// 停用提示"该账号会话将立即失效"；无删除；不能对当前登录账号操作。

export interface ManagedUserItem {
  id: string;
  username: string;
  name: string;
  role: string;
  status: string;
  createdAtLabel: string;
}

const INPUT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function UsersManager({
  users,
  currentUserId,
}: {
  users: ManagedUserItem[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 一次性初始密码：展示后关闭即不可恢复（状态清空）
  const [credential, setCredential] = useState<{
    title: string;
    username: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  async function createUser(input: {
    username: string;
    name: string;
    role: UserRole;
  }): Promise<void> {
    setError(null);
    setNotice(null);
    const response = await fetch("/api/settings/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => null)) as
      | { user?: { initialPassword?: string }; error?: { message?: string } }
      | null;
    if (!response.ok || !payload?.user?.initialPassword) {
      setError(payload?.error?.message ?? "新建账号失败，请稍后再试");
      return;
    }
    setCreating(false);
    setCredential({
      title: "账号已创建，初始密码如下",
      username: input.username,
      password: payload.user.initialPassword,
    });
    setCopied(false);
    router.refresh();
  }

  async function resetPassword(user: ManagedUserItem): Promise<void> {
    if (
      !window.confirm(
        `重置「${user.name}（${user.username}）」的密码？重置后当前密码立即失效，该账号已登录的会话将全部退出。`,
      )
    ) {
      return;
    }
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/settings/users/${user.id}/reset-password`, {
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | { user?: { initialPassword?: string }; error?: { message?: string } }
        | null;
      if (!response.ok || !payload?.user?.initialPassword) {
        setError(payload?.error?.message ?? "重置失败，请稍后再试");
        return;
      }
      setCredential({
        title: "密码已重置，新初始密码如下",
        username: user.username,
        password: payload.user.initialPassword,
      });
      setCopied(false);
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(user: ManagedUserItem, status: "active" | "disabled"): Promise<void> {
    if (
      status === "disabled" &&
      !window.confirm(
        `停用「${user.name}（${user.username}）」？该账号会话将立即失效，且无法再登录。`,
      )
    ) {
      return;
    }
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/settings/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "操作失败，请稍后再试");
        return;
      }
      setNotice(status === "disabled" ? "账号已停用，会话已全部失效。" : "账号已启用，可正常登录。");
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusyId(null);
    }
  }

  async function copyCredential(): Promise<void> {
    if (!credential) {
      return;
    }
    try {
      await navigator.clipboard.writeText(credential.password);
      setCopied(true);
    } catch {
      // 剪贴板不可用（非安全上下文等）：选中文本兜底，提示手动复制
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          账号由管理员统一创建（不开放自助注册）；初始密码仅在创建/重置时显示一次，
          请提醒本人登录后修改；账号无删除操作，只能停用。
        </p>
        <button
          type="button"
          onClick={() => setCreating((prev) => !prev)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          {creating ? "收起新建表单" : "＋ 新建账号"}
        </button>
      </div>

      {creating && <CreateUserForm onCreated={createUser} />}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {credential && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">{credential.title}</p>
          <p className="mt-1 text-sm text-amber-800">
            账号 {credential.username} 的初始密码：
            <code className="mx-1 rounded bg-white px-2 py-0.5 font-mono text-base text-gray-900 select-all">
              {credential.password}
            </code>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void copyCredential()}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-900 transition hover:bg-amber-100"
            >
              {copied ? "已复制" : "复制密码"}
            </button>
            <button
              type="button"
              onClick={() => setCredential(null)}
              className="rounded-md px-3 py-1.5 text-sm text-amber-800 underline transition hover:text-amber-950"
            >
              我已保存，关闭（关闭后不再显示）
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-700">
            此密码仅显示这一次，请立即复制并告知本人；建议本人首次登录后修改密码。
          </p>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">用户名</th>
              <th className="px-3 py-2 font-medium">姓名</th>
              <th className="px-3 py-2 font-medium">角色</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">创建时间</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-gray-50 last:border-b-0">
                <td className="px-3 py-2 font-mono text-xs text-gray-700">
                  {user.username}
                  {user.id === currentUserId && (
                    <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                      当前登录
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-900">{user.name}</td>
                <td className="px-3 py-2 text-gray-500">
                  {ROLE_LABELS[user.role as UserRole] ?? user.role}
                </td>
                <td className="px-3 py-2">
                  {user.status === "active" ? (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                      启用中
                    </span>
                  ) : (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                      已停用
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500">{user.createdAtLabel}</td>
                <td className="px-3 py-2 text-right">
                  {user.id === currentUserId ? (
                    <span className="text-xs text-gray-400">在「账号与密码」中修改</span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={busyId === user.id}
                        onClick={() => void resetPassword(user)}
                        className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
                      >
                        重置密码
                      </button>
                      <button
                        type="button"
                        disabled={busyId === user.id}
                        onClick={() =>
                          void setStatus(user, user.status === "active" ? "disabled" : "active")
                        }
                        className={`rounded-md px-2.5 py-1 text-xs transition disabled:opacity-60 ${
                          user.status === "active"
                            ? "border border-red-200 bg-white text-red-600 hover:bg-red-50"
                            : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        {user.status === "active" ? "停用" : "启用"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreateUserForm({
  onCreated,
}: {
  onCreated: (input: { username: string; name: string; role: UserRole }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("sales");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreated({ username: username.trim(), name: name.trim(), role });
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-lg border border-blue-100 bg-blue-50/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="mb-3 text-sm font-semibold text-gray-900">新建账号</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">用户名 *（字母/数字/下划线/中划线，2–64 位）</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            minLength={2}
            maxLength={64}
            className={`${INPUT_CLASS} font-mono`}
            placeholder="如 zhangsan"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">姓名 *</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={64}
            className={INPUT_CLASS}
            placeholder="如 张三"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">角色 *</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
            className={INPUT_CLASS}
          >
            <option value="sales">销售</option>
            <option value="admin">管理员</option>
          </select>
        </label>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        保存后将生成一次性初始密码，请当场复制告知本人。
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !username.trim() || !name.trim()}
        className="mt-3 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "创建中…" : "创建账号"}
      </button>
    </form>
  );
}
