import { Controller, Get } from "@nestjs/common";
import { marketPulse } from "./market.js";

@Controller("market")
export class MarketController {
  @Get("pulse")
  pulse() {
    return marketPulse();
  }
}
