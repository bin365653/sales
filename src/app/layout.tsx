import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "勤策 AI 销售作战台",
    template: "%s · 勤策 AI 销售作战台",
  },
  description: "轻量级 AI 销售工作台：线索管理、AI 销售辅助、任务跟进与数据看板。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
