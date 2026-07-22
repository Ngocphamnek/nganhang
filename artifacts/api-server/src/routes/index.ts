import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import keysRouter from "./keys";
import settingsRouter from "./settings";
import gamesRouter from "./games";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/keys", keysRouter);
router.use("/settings", settingsRouter);
router.use("/games", gamesRouter);

export default router;
