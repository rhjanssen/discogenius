// Ported from Fluent UI theme-designer to keep palette generation aligned with the official tool.
import type { BrandVariants } from '@fluentui/react-components';
import type { Palette } from './types';
import { hexColorsFromPalette, hex_to_LCH } from './palettes';

type Options = {
    darkCp?: number;
    lightCp?: number;
    hueTorsion?: number;
};

export function getBrandTokensFromPalette(keyColor: string, options: Options = {}): BrandVariants {
    const { darkCp = 2 / 3, lightCp = 1 / 3, hueTorsion = 0 } = options;
    const brandPalette: Palette = {
        keyColor: hex_to_LCH(keyColor),
        darkCp,
        lightCp,
        hueTorsion,
    };
    const hexColors = hexColorsFromPalette(keyColor, brandPalette, 16, 1);
    return hexColors.reduce((acc: Record<string, string>, hexColor, h) => {
        acc[`${(h + 1) * 10}`] = hexColor;
        return acc;
    }, {}) as BrandVariants;
}
