import type { Request, Response } from 'express';
import { ReservationService, reservationService } from './reservation.service.js';
import {
  createReservationSchema,
  reservationIdParamSchema,
} from './reservation.schema.js';
import { productIdParamSchema } from './inventory.schema.js';

export class ReservationController {
  private readonly service: ReservationService;

  constructor(service: ReservationService = reservationService) {
    this.service = service;
  }

  /**
   * POST /api/inventory/:productId/reservations
   * Creates a temporary stock reservation hold with TTL.
   */
  public create = async (req: Request, res: Response): Promise<void> => {
    const params = productIdParamSchema.parse(req.params);
    const body = createReservationSchema.parse(req.body);
    const reservation = await this.service.createReservation(params.productId, body);
    res.status(201).json(reservation);
  };

  /**
   * POST /api/inventory/reservations/:reservationId/confirm
   * Confirms a temporary reservation hold, permanently consuming stock.
   */
  public confirm = async (req: Request, res: Response): Promise<void> => {
    const params = reservationIdParamSchema.parse(req.params);
    const reservation = await this.service.confirmReservation(params.reservationId);
    res.status(200).json(reservation);
  };

  /**
   * POST /api/inventory/reservations/:reservationId/cancel
   * Cancels a temporary reservation hold and releases reserved stock.
   */
  public cancel = async (req: Request, res: Response): Promise<void> => {
    const params = reservationIdParamSchema.parse(req.params);
    const reservation = await this.service.cancelReservation(params.reservationId);
    res.status(200).json(reservation);
  };

  /**
   * GET /api/inventory/reservations/:reservationId
   * Retrieves durable reservation status and expiry metadata.
   */
  public getById = async (req: Request, res: Response): Promise<void> => {
    const params = reservationIdParamSchema.parse(req.params);
    const reservation = await this.service.getReservation(params.reservationId);
    res.status(200).json(reservation);
  };
}

export const reservationController = new ReservationController();
