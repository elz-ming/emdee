declare module "html2pdf.js" {
  interface Html2PdfOptions {
    margin?: number | number[];
    filename?: string;
    image?: { type?: string; quality?: number };
    html2canvas?: {
      scale?: number;
      useCORS?: boolean;
      backgroundColor?: string | null;
      [key: string]: unknown;
    };
    jsPDF?: {
      unit?: "pt" | "mm" | "cm" | "in";
      format?: string | number[];
      orientation?: "portrait" | "landscape";
      [key: string]: unknown;
    };
    pagebreak?: { mode?: string | string[]; before?: string; after?: string; avoid?: string };
    enableLinks?: boolean;
    width?: number;
    windowWidth?: number;
  }

  interface Html2Pdf {
    set(opt: Html2PdfOptions): Html2Pdf;
    from(element: Element | string, type?: "element" | "string" | "canvas" | "img"): Html2Pdf;
    save(): Promise<void>;
    output(type?: string): Promise<Blob | string>;
    outputPdf(type?: string): Promise<Blob | string>;
    then(fn: (val: unknown) => unknown): Html2Pdf;
  }

  function html2pdf(): Html2Pdf;
  export default html2pdf;
}
