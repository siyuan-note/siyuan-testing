// 使用明确的字形坐标生成 PDF，避免把真实用户附件加入测试仓库。
export const createPdfFixture = (id: string) => {
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("Invalid PDF fixture ID");
    const stream = [
        `% ${id}`,
        "BT /F1 12 Tf 25 400 Td (by) Tj 17 0 Td (asymmetrically) Tj 83 0 Td (texturing) Tj ET",
        "BT /F1 12 Tf 25 340 Td (Fol-) Tj 0 -18 Td (lowing) Tj ET",
    ].join("\n");
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 6 0 R 7 0 R] /Count 3 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    ];
    let source = "%PDF-1.7\n";
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(source.length);
        source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = source.length;
    source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    source += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
    source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(source, "ascii");
};
