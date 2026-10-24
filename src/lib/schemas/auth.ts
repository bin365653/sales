import { z } from "zod";

// 认证相关入参 Schema：API 入参与前端表单共用同一份定义（实施计划 §2.1）。

export const loginSchema = z.object({
  username: z.string().trim().min(1, "请输入用户名").max(64, "用户名过长"),
  password: z.string().min(1, "请输入密码").max(128, "密码过长"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "请输入当前密码").max(128, "密码过长"),
    newPassword: z
      .string()
      .min(8, "新密码至少 8 位")
      .max(128, "新密码最长 128 位"),
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: "新密码不能与当前密码相同",
    path: ["newPassword"],
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
