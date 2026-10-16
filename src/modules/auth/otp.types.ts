export type OtpPurpose = 'email-verification' | 'password-reset';

export interface RequestEmailVerificationInput {
  email: string;
}

export interface VerifyEmailInput {
  email: string;
  otp: string;
}

export interface RequestPasswordResetInput {
  email: string;
}

export interface VerifyPasswordResetInput {
  email: string;
  otp: string;
  newPassword: string;
}

export enum OtpVerifyResult {
  SUCCESS = 1,
  INVALID_OTP = 0,
  EXPIRED_OR_NOT_FOUND = -1,
  MAX_ATTEMPTS_EXCEEDED = -2,
}
