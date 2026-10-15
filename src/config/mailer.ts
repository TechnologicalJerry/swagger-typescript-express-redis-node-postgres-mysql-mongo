import nodemailer, { type Transporter } from 'nodemailer';
import { env } from './env.js';
import { logger } from './logger.js';

export class MailerService {
  private static instance: MailerService | null = null;
  private readonly transporter: Transporter;

  private constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
            }
          : undefined,
    });
  }

  public static getInstance(): MailerService {
    if (!MailerService.instance) {
      MailerService.instance = new MailerService();
    }
    return MailerService.instance;
  }

  /**
   * Sends an email verification OTP message.
   * Never logs the actual OTP code.
   */
  public async sendEmailVerificationOtp(
    to: string,
    otp: string,
    displayName?: string,
  ): Promise<void> {
    const name = displayName || 'User';
    const mailOptions = {
      from: env.EMAIL_FROM,
      to,
      subject: 'Verify your email address - Redis Learning Backend',
      text: `Hello ${name},\n\nYour email verification code is: ${otp}\n\nThis code will expire in ${Math.floor(env.OTP_EXPIRATION_SECONDS / 60)} minutes.\nIf you did not request this code, please ignore this email.`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; line-height: 1.5;">
          <h2>Email Verification</h2>
          <p>Hello ${name},</p>
          <p>Your one-time verification code is:</p>
          <h1 style="font-size: 32px; letter-spacing: 5px; color: #2563eb;">${otp}</h1>
          <p>This code will expire in <strong>${Math.floor(env.OTP_EXPIRATION_SECONDS / 60)} minutes</strong>.</p>
          <p>If you did not request this email, please ignore it.</p>
        </div>
      `,
    };

    logger.info({ recipient: to }, 'Dispatching email verification OTP');
    await this.transporter.sendMail(mailOptions);
  }

  /**
   * Sends a password reset OTP message.
   * Never logs the actual OTP code.
   */
  public async sendPasswordResetOtp(
    to: string,
    otp: string,
    displayName?: string,
  ): Promise<void> {
    const name = displayName || 'User';
    const mailOptions = {
      from: env.EMAIL_FROM,
      to,
      subject: 'Password reset request - Redis Learning Backend',
      text: `Hello ${name},\n\nYour password reset code is: ${otp}\n\nThis code will expire in ${Math.floor(env.OTP_EXPIRATION_SECONDS / 60)} minutes.\nIf you did not request a password reset, your account is still secure and you can ignore this email.`,
      html: `
        <div style="font-family: sans-serif; padding: 20px; line-height: 1.5;">
          <h2>Password Reset Request</h2>
          <p>Hello ${name},</p>
          <p>Your one-time password reset code is:</p>
          <h1 style="font-size: 32px; letter-spacing: 5px; color: #dc2626;">${otp}</h1>
          <p>This code will expire in <strong>${Math.floor(env.OTP_EXPIRATION_SECONDS / 60)} minutes</strong>.</p>
          <p>If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `,
    };

    logger.info({ recipient: to }, 'Dispatching password reset OTP');
    await this.transporter.sendMail(mailOptions);
  }
}

export const mailerService = MailerService.getInstance();
