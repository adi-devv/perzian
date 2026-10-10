// Runtime dock icon. The drawing itself lives in icon-pixels.js (no Electron dependency) so the
// build can render the same mark into the packaged app's .icns.
import { nativeImage } from "electron";
import { iconBGRA } from "./icon-pixels.js";

export function makeIcon(size = 512) {
  return nativeImage.createFromBitmap(iconBGRA(size), { width: size, height: size });
}
