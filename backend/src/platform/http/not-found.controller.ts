import { All, Controller, NotFoundException } from '@nestjs/common';
import { Access } from './route-access';

@Access('public')
@Controller()
export class NotFoundController {
  @All('*path')
  notFound(): never {
    throw new NotFoundException();
  }
}
