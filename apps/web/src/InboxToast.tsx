import React, { useEffect, useRef, useState } from "react";

/** The toast message and its 3-second timer; a new message replaces the old one. */
export function useInboxToast() {
  const [notification, setNotification] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const notify = (message: string) => {
    if (timer.current) clearTimeout(timer.current);
    setNotification(message); timer.current = setTimeout(() => setNotification(""), 3000);
  };
  return { notification, notify };
}

export function InboxToast({ message }: { message: string }) {
  return message ? <div className="inbox-toast" role="status">{message}</div> : null;
}
