import type { Vec3 } from './types';

type MatrixIO = number[][] | number[];

function isFlat(A: MatrixIO): A is number[] {
    return !Array.isArray(A[0]);
}

function multiplyMatrices(AMatrixOrVector: MatrixIO, BMatrixOrVector: MatrixIO): MatrixIO {
    const m = AMatrixOrVector.length;

    const A: number[][] = isFlat(AMatrixOrVector) ? [AMatrixOrVector] : AMatrixOrVector;

    const B: number[][] = isFlat(BMatrixOrVector) ? BMatrixOrVector.map(x => [x]) : BMatrixOrVector;

    const p = B[0].length;
    const B_cols = B[0].map((_, i) => B.map(x => x[i]));
    let product: MatrixIO = A.map(row =>
        B_cols.map(col => {
            if (!Array.isArray(row)) {
                return col.reduce((a, c) => a + c * row, 0);
            }

            return row.reduce((a, c, i) => a + c * (col[i] || 0), 0);
        }),
    );

    if (m === 1) {
        product = product[0];
    }

    if (p === 1) {
        return (product as number[][]).map(x => x[0]);
    }

    return product;
}

export function lin_sRGB(RGB: Vec3): Vec3 {
    return RGB.map(val => {
        const sign = val < 0 ? -1 : 1;
        const abs = Math.abs(val);

        if (abs < 0.04045) {
            return val / 12.92;
        }

        return sign * Math.pow((abs + 0.055) / 1.055, 2.4);
    }) as Vec3;
}

export function gam_sRGB(RGB: Vec3): Vec3 {
    return RGB.map(val => {
        const sign = val < 0 ? -1 : 1;
        const abs = Math.abs(val);

        if (abs > 0.0031308) {
            return sign * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
        }

        return 12.92 * val;
    }) as Vec3;
}

export function lin_sRGB_to_XYZ(rgb: Vec3): Vec3 {
    const M = [
        [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
        [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
        [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
    ];
    return multiplyMatrices(M, rgb) as Vec3;
}

export function XYZ_to_lin_sRGB(XYZ: Vec3): Vec3 {
    const M = [
        [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
        [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
        [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
    ];

    return multiplyMatrices(M, XYZ) as Vec3;
}

export function D65_to_D50(XYZ: Vec3): Vec3 {
    const M = [
        [1.0479298208405488, 0.022946793341019088, -0.05019222954313557],
        [0.029627815688159344, 0.990434484573249, -0.01707382502938514],
        [-0.009243058152591178, 0.015055144896577895, 0.7518742899580008],
    ];

    return multiplyMatrices(M, XYZ) as Vec3;
}

export function D50_to_D65(XYZ: Vec3): Vec3 {
    const M = [
        [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
        [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
        [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
    ];

    return multiplyMatrices(M, XYZ) as Vec3;
}

export function XYZ_to_Lab(XYZ: Vec3): Vec3 {
    const epsilon = 216 / 24389;
    const kappa = 24389 / 27;
    const white = [0.96422, 1.0, 0.82521];

    const xyz = XYZ.map((value, i) => value / white[i]);

    const f = xyz.map(value => (value > epsilon ? Math.cbrt(value) : (kappa * value + 16) / 116));

    return [
        116 * f[1] - 16,
        500 * (f[0] - f[1]),
        200 * (f[1] - f[2]),
    ] as Vec3;
}

export function Lab_to_XYZ(Lab: Vec3): Vec3 {
    const kappa = 24389 / 27;
    const epsilon = 216 / 24389;
    const white = [0.96422, 1.0, 0.82521];
    const f = [] as number[];

    f[1] = (Lab[0] + 16) / 116;
    f[0] = Lab[1] / 500 + f[1];
    f[2] = f[1] - Lab[2] / 200;

    const xyz = [
        Math.pow(f[0], 3) > epsilon ? Math.pow(f[0], 3) : (116 * f[0] - 16) / kappa,
        Lab[0] > kappa * epsilon ? Math.pow((Lab[0] + 16) / 116, 3) : Lab[0] / kappa,
        Math.pow(f[2], 3) > epsilon ? Math.pow(f[2], 3) : (116 * f[2] - 16) / kappa,
    ];

    return xyz.map((value, i) => value * white[i]) as Vec3;
}

export function Lab_to_LCH(Lab: Vec3): Vec3 {
    const hue = (Math.atan2(Lab[2], Lab[1]) * 180) / Math.PI;
    return [
        Lab[0],
        Math.sqrt(Math.pow(Lab[1], 2) + Math.pow(Lab[2], 2)),
        hue >= 0 ? hue : hue + 360,
    ] as Vec3;
}

export function LCH_to_Lab(LCH: Vec3): Vec3 {
    return [
        LCH[0],
        LCH[1] * Math.cos((LCH[2] * Math.PI) / 180),
        LCH[1] * Math.sin((LCH[2] * Math.PI) / 180),
    ] as Vec3;
}

export function sRGB_to_LCH(RGB: Vec3): Vec3 {
    return Lab_to_LCH(XYZ_to_Lab(D65_to_D50(lin_sRGB_to_XYZ(lin_sRGB(RGB)))));
}

export function LCH_to_sRGB(LCH: Vec3): Vec3 {
    return gam_sRGB(XYZ_to_lin_sRGB(D50_to_D65(Lab_to_XYZ(LCH_to_Lab(LCH)))));
}

export function LAB_to_sRGB(LAB: Vec3): Vec3 {
    return gam_sRGB(XYZ_to_lin_sRGB(D50_to_D65(Lab_to_XYZ(LAB))));
}

function is_LCH_inside_sRGB(l: number, c: number, h: number): boolean {
    const epsilon = 0.000005;
    const rgb = LCH_to_sRGB([+l, +c, +h]);
    return rgb.reduce((a: boolean, b: number) => a && b >= 0 - epsilon && b <= 1 + epsilon, true);
}

export function snap_into_gamut(Lab: Vec3): Vec3 {
    const epsilon = 0.0001;

    const LCH = Lab_to_LCH(Lab);
    const l = LCH[0];
    let c = LCH[1];
    const h = LCH[2];

    if (is_LCH_inside_sRGB(l, c, h)) {
        return Lab;
    }

    let hiC = c;
    let loC = 0;
    c /= 2;

    while (hiC - loC > epsilon) {
        if (is_LCH_inside_sRGB(l, c, h)) {
            loC = c;
        } else {
            hiC = c;
        }
        c = (hiC + loC) / 2;
    }

    return LCH_to_Lab([l, c, h]);
}
