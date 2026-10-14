declare module "culori" {
  export type Rgb = {
    mode: "rgb";
    r: number;
    g: number;
    b: number;
  };

  export function differenceCiede2000(): (left: Rgb, right: Rgb) => number;
}
