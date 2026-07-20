import { AdminApp } from "./admin/AdminApp";
import { CaptchaWidget } from "./widget/CaptchaWidget";

export function App() {
  return window.location.pathname.startsWith("/embed/v1/widget") ? <CaptchaWidget /> : <AdminApp />;
}
