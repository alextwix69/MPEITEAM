import { All, Controller, NotFoundException } from '@nestjs/common';

@Controller()
export class NotFoundController {
  @All('*path')
  notFound(): never {
    throw new NotFoundException();
  }
}
