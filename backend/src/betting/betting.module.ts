import { Module } from '@nestjs/common';
import { BettingController, BettingStreamController } from './betting.controller';
import { BettingService } from './betting.service';
import { LiveFeedService } from './live-feed.service';

@Module({
  controllers: [BettingController, BettingStreamController],
  providers: [BettingService, LiveFeedService],
  exports: [BettingService, LiveFeedService],
})
export class BettingModule {}
