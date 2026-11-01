import { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

// El tamaño y el trazo los fija `svg.ic` en kp.css; `className` admite s14 / s16 / s24.
const mk =
  (d: ReactNode) =>
  ({ className = "", ...p }: P) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`ic ${className}`.trim()} {...p}>
      {d}
    </svg>
  );

export const IconSearch = mk(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconPlus = mk(<path d="M12 5v14M5 12h14" />);
export const IconX = mk(<path d="M6 6l12 12M18 6 6 18" />);
export const IconMinus = mk(<path d="M5 12h14" />);
export const IconFolder = mk(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
export const IconSettings = mk(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>,
);
export const IconLock = mk(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
export const IconKey = mk(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M16 7l3 3M14 9l2 2" /></>);
export const IconEdit = mk(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
export const IconTrash = mk(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />);
export const IconCheck = mk(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconShield = mk(<><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" /><path d="m9 12 2 2 4-4" /></>);
export const IconFingerprint = mk(
  <path d="M12 11v3c0 2-.5 4-1.5 6M8 20c1-2 1.5-4 1.5-6v-2a2.5 2.5 0 0 1 5 0v2c0 1.5-.2 3-.7 4.5M5 17c.7-1.5 1-3 1-5a6 6 0 0 1 12 0c0 1 0 2-.2 3M4 9a8 8 0 0 1 16 0" />,
);
export const IconInfo = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IconAlert = mk(<><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h.01" /></>);
export const IconEye = mk(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const IconRefresh = mk(<path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4" />);
export const IconStar = mk(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />);

export const IconBack = mk(<path d="m15 5-7 7 7 7" />);
export const IconCopy = mk(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>);
export const IconEyeOff = mk(<><path d="M3 3l18 18" /><path d="M10.6 6.2A10.5 10.5 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6A17 17 0 0 0 2 12s3.6 6 10 6a10 10 0 0 0 4-.8" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>);
export const IconExternal = mk(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>);
export const IconDownload = mk(<path d="M12 4v11M7 11l5 5 5-5M5 20h14" />);
export const IconPaperclip = mk(<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.5 17a1.7 1.7 0 0 1-2.4-2.4L14 7.7" />);
export const IconGlobe = mk(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></>);
export const IconUser = mk(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IconMail = mk(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>);
export const IconServer = mk(<><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></>);
export const IconTerminal = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>);
export const IconNote = mk(<><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h7" /></>);
export const IconCard = mk(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></>);
export const IconHome = mk(<path d="m4 11 8-7 8 7v9H5z M10 20v-6h4v6" />);
export const IconClock = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconWrench = mk(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.6-.6-.6-2.6z" />);
export const IconDatabase = mk(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>);
