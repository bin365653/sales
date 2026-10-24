export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold">勤策 AI 销售作战台</h1>
      <p className="text-base leading-7 text-gray-600">
        工程基座（T01）已就绪：Next.js 15 + Prisma + PostgreSQL，Docker
        Compose 一键启动，数据库迁移与基础数据 seed 幂等可重复执行。
      </p>
      <p className="text-sm text-gray-500">
        登录与业务页面将随后续任务交付，当前可访问{" "}
        <a className="text-blue-600 underline" href="/api/health">
          /api/health
        </a>{" "}
        查看服务健康状态。
      </p>
    </main>
  );
}
