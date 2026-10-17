export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

export interface ReservationRecord {
  id: string;
  productId: string;
  quantity: number;
  status: ReservationStatus;
  idempotencyKey: string;
  expiresAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  isExpired?: boolean;
}

export interface CreateReservationInput {
  quantity: number;
  idempotencyKey: string;
  ttlSeconds?: number;
}

export interface RawReservationRow {
  id: string;
  product_id: string;
  quantity: number;
  status: string;
  idempotency_key: string;
  expires_at: Date | string;
  confirmed_at: Date | string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CachedReservation {
  id: string;
  productId: string;
  quantity: number;
  status: ReservationStatus;
  expiresAt: string;
}

export interface LockAcquireResult {
  acquired: boolean;
  token: string | null;
}

export interface ReservationExpiryJobResult {
  status: 'SUCCESS' | 'NO_OP' | 'PARTIAL_FAILURE';
  scannedCount: number;
  expiredCount: number;
  errors?: string[];
}
