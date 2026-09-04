import { Module } from '@nestjs/common';
import { ProfilesService } from './application/profiles.service';

@Module({
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
