import { useEffect, useState } from "react";
import { isPhoneViewport } from "../lib/platform";

/** Live phone-viewport flag — tracks resize/orientation changes. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => isPhoneViewport());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setPhone(mq.matches);
    setPhone(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return phone;
}
