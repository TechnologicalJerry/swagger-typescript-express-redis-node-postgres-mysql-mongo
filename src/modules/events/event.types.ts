export enum PubSubChannel {
  PRODUCTS = 'events:products',
  INVENTORY = 'events:inventory',
  RESERVATIONS = 'events:reservations',
  AUTH = 'events:auth',
}

export interface DomainEvent<T = Record<string, unknown>> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  correlationId?: string;
  producer: string;
  payload: T;
}

// Product Payloads
export interface ProductCreatedPayload {
  productId: string;
  sku: string;
  name: string;
  price: number;
  category: string;
}

export interface ProductUpdatedPayload {
  productId: string;
  updatedFields: string[];
}

export interface ProductDeletedPayload {
  productId: string;
}

// Inventory Payloads
export interface InventoryAdjustedPayload {
  productId: string;
  previousQuantity: number;
  newQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

// Reservation Payloads
export interface ReservationCreatedPayload {
  reservationId: string;
  productId: string;
  quantity: number;
  expiresAt: string;
  idempotencyKey: string;
}

export interface ReservationConfirmedPayload {
  reservationId: string;
  productId: string;
  quantity: number;
  confirmedAt: string;
}

export interface ReservationCancelledPayload {
  reservationId: string;
  productId: string;
  quantity: number;
  cancelledAt: string;
}

export interface ReservationExpiredPayload {
  reservationId: string;
  productId: string;
  quantity: number;
  expiredAt: string;
}

// Auth Payloads (never containing credentials or tokens)
export interface AuthLoginSucceededPayload {
  userId: string;
  email: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthLoginFailedPayload {
  email: string;
  reason: string;
  ipAddress?: string;
  userAgent?: string;
}

export type EventHandler<T = Record<string, unknown>> = (event: DomainEvent<T>) => Promise<void>;
