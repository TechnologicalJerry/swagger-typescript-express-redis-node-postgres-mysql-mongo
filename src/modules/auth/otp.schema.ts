import { z } from 'zod';

export const requestEmailVerificationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, 'Email is required')
      .email('Invalid email address')
      .max(255, 'Email cannot exceed 255 characters'),
  })
  .strict();

export const verifyEmailSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, 'Email is required')
      .email('Invalid email address')
      .max(255, 'Email cannot exceed 255 characters'),
    otp: z
      .string()
      .trim()
      .min(4, 'OTP must be at least 4 digits')
      .max(10, 'OTP cannot exceed 10 digits')
      .regex(/^\d+$/, 'OTP must contain numeric digits only'),
  })
  .strict();

export const requestPasswordResetSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, 'Email is required')
      .email('Invalid email address')
      .max(255, 'Email cannot exceed 255 characters'),
  })
  .strict();

export const verifyPasswordResetSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1, 'Email is required')
      .email('Invalid email address')
      .max(255, 'Email cannot exceed 255 characters'),
    otp: z
      .string()
      .trim()
      .min(4, 'OTP must be at least 4 digits')
      .max(10, 'OTP cannot exceed 10 digits')
      .regex(/^\d+$/, 'OTP must contain numeric digits only'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters long')
      .max(72, 'Password cannot exceed 72 characters'),
  })
  .strict();
