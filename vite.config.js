import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fahrerIcons from "./src/fahrer/iconsPlugin.js";

export default defineConfig({
  plugins: [react(), fahrerIcons()],
});
