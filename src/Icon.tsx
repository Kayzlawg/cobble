const paths = {
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  play: "M7 4l13 8-13 8z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  folder: "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  x: "M18 6L6 18M6 6l12 12",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  circle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  circleCheck: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8 12l3 3 5-6",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  compress: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  arrow: "M5 12h14M13 6l6 6-6 6",
  minus: "M5 12h14",
  square: "M5 5h14v14H5z",
  restore: "M8 8h11v11H8zM5 16V5h11",
  alert:"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 8v4M12 16h.01",
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
