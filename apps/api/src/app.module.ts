import { Module } from "@nestjs/common";
import { ScansController } from "./scans/scans.controller.js";
import { ScansService } from "./scans/scans.service.js";

@Module({
  controllers: [ScansController],
  providers: [ScansService],
})
export class AppModule {}
