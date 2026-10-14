import type { Request, Response } from 'express';
import { UserService, userService } from './user.service.js';
import {
  createUserSchema,
  updateUserSchema,
  userIdParamSchema,
  listUsersQuerySchema,
} from './user.schema.js';

export class UserController {
  private readonly service: UserService;

  constructor(service: UserService = userService) {
    this.service = service;
  }

  public create = async (req: Request, res: Response): Promise<void> => {
    const input = createUserSchema.parse(req.body);
    const user = await this.service.createUser(input);
    res.status(201).json(user);
  };

  public list = async (req: Request, res: Response): Promise<void> => {
    const query = listUsersQuerySchema.parse(req.query);
    const result = await this.service.listUsers(query.page, query.limit);
    res.status(200).json(result);
  };

  public getById = async (req: Request, res: Response): Promise<void> => {
    const params = userIdParamSchema.parse(req.params);
    const user = await this.service.getUserById(params.id);
    res.status(200).json(user);
  };

  public update = async (req: Request, res: Response): Promise<void> => {
    const params = userIdParamSchema.parse(req.params);
    const body = updateUserSchema.parse(req.body);
    const user = await this.service.updateUserProfile(params.id, body);
    res.status(200).json(user);
  };

  public deactivate = async (req: Request, res: Response): Promise<void> => {
    const params = userIdParamSchema.parse(req.params);
    const user = await this.service.deactivateUser(params.id);
    res.status(200).json(user);
  };
}

export const userController = new UserController();
