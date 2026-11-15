using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshShot
{
    public enum ToolKind { None, Rect, Ellipse, Line, Arrow, Pen, Mosaic, Text }

    public enum BtnKind { Rect, Ellipse, Line, Arrow, Pen, Mosaic, Text, Undo, Redo, Copy, Save, Cancel, Confirm }

    public class Op
    {
        public ToolKind Kind;
        public RectangleF Rect;
        public PointF Start;
        public PointF End;
        public List<PointF> Points = new List<PointF>();
        public string Text;
        public Color Color = Color.FromArgb(229, 57, 53);
        public float Width = 4f;
        public PointF Origin;
        public Bitmap Snapshot;
    }

    public class Result
    {
        public string Action;
        public int Width;
        public int Height;
    }

    /// <summary>
    /// WeChat-style snip: hover a window to highlight it, click to take it (or drag
    /// a region), resize the frame from its four edges and corners, annotate in
    /// place, re-select and fine-tune any annotation, then insert / copy / save.
    /// </summary>
    public class EditorForm : Form
    {
        /* ---------------------------------------------------------------- *
         * Win32
         * ---------------------------------------------------------------- */
        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumProc callback, IntPtr param);

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hwnd);

        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

        [DllImport("user32.dll")]
        static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("dwmapi.dll")]
        static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);

        delegate bool EnumProc(IntPtr hwnd, IntPtr param);

        const int GWL_EXSTYLE = -20;
        const int WS_EX_TOOLWINDOW = 0x80;
        const int WS_EX_NOACTIVATE = 0x08000000;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

        /* ---------------------------------------------------------------- *
         * State
         * ---------------------------------------------------------------- */
        readonly Bitmap full;
        readonly string outPath;
        readonly bool selfTest;

        Rectangle sel;
        bool hasSel;

        Rectangle hover;
        bool hasHover;

        readonly List<Op> ops = new List<Op>();
        readonly List<Op> redo = new List<Op>();
        readonly List<BtnKind> buttons = new List<BtnKind>();
        readonly List<Rectangle> buttonRects = new List<Rectangle>();
        readonly List<Rectangle> swatchRects = new List<Rectangle>();
        readonly List<Rectangle> widthRects = new List<Rectangle>();
        readonly List<Rectangle> groupRects = new List<Rectangle>();

        static readonly Color[] Palette = new Color[]
        {
            Color.FromArgb(229, 57, 53),
            Color.FromArgb(251, 140, 0),
            Color.FromArgb(253, 216, 53),
            Color.FromArgb(67, 160, 71),
            Color.FromArgb(0, 172, 193),
            Color.FromArgb(30, 136, 229),
            Color.FromArgb(142, 36, 170),
            Color.FromArgb(255, 255, 255),
        };

        static readonly float[] Widths = new float[] { 2f, 4f, 8f };

        static readonly Color Accent = Color.FromArgb(47, 107, 255);
        static readonly Color Frame = Color.FromArgb(7, 193, 96);

        ToolKind tool = ToolKind.None;
        Color color = Color.FromArgb(229, 57, 53);
        float strokeWidth = 4f;

        Op pending;
        Point dragStart;
        bool dragging;
        bool selecting;
        bool moving;

        Op selected;
        Op moveBase;
        int handleIndex = -1;

        TextBox input;
        Op textOp;

        Rectangle panel;
        Rectangle palettePanel;
        int hoverIndex = -1;

        enum Zone { None, Left, Right, Top, Bottom, TopLeft, TopRight, BottomLeft, BottomRight, Inside }

        Zone zone = Zone.None;
        Rectangle zoneBase;
        Point zoneOrigin;

        Timer tick;
        Result result;

        public EditorForm(Bitmap full, Rectangle preset, string outPath, bool selfTest)
        {
            this.full = full;
            this.outPath = outPath;
            this.selfTest = selfTest;

            sel = preset.Width > 8 ? Rectangle.Intersect(preset, new Rectangle(0, 0, full.Width, full.Height)) : Rectangle.Empty;
            hasSel = sel.Width > 8 && sel.Height > 8;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            Bounds = SystemInformation.VirtualScreen;
            TopMost = true;
            ShowInTaskbar = false;
            KeyPreview = true;
            DoubleBuffered = true;
            BackColor = Color.Black;
            Cursor = Cursors.Cross;

            buttons.Add(BtnKind.Rect);
            buttons.Add(BtnKind.Ellipse);
            buttons.Add(BtnKind.Line);
            buttons.Add(BtnKind.Arrow);
            buttons.Add(BtnKind.Pen);
            buttons.Add(BtnKind.Mosaic);
            buttons.Add(BtnKind.Text);
            buttons.Add(BtnKind.Undo);
            buttons.Add(BtnKind.Redo);
            buttons.Add(BtnKind.Copy);
            buttons.Add(BtnKind.Save);
            buttons.Add(BtnKind.Cancel);
            buttons.Add(BtnKind.Confirm);

            Recalculate();
        }

        bool ShapeTool
        {
            get { return tool == ToolKind.Rect || tool == ToolKind.Ellipse || tool == ToolKind.Line || tool == ToolKind.Arrow; }
        }

        bool ShowPalette
        {
            get
            {
                if (!hasSel) return false;
                if (ShapeTool || tool == ToolKind.Text) return true;
                if (selected == null) return false;
                switch (selected.Kind)
                {
                    case ToolKind.Rect:
                    case ToolKind.Ellipse:
                    case ToolKind.Line:
                    case ToolKind.Arrow:
                    case ToolKind.Text:
                        return true;
                    default:
                        return false;
                }
            }
        }

        /* ---------------------------------------------------------------- *
         * Layout: white bar right-aligned with the selection, optional second row
         * ---------------------------------------------------------------- */
        void Recalculate()
        {
            const int pad = 5;
            const int size = 32;
            const int gap = 2;
            const int groupGap = 11;

            buttonRects.Clear();
            groupRects.Clear();
            swatchRects.Clear();
            widthRects.Clear();

            int x = pad;
            for (int i = 0; i < buttons.Count; i++)
            {
                BtnKind kind = buttons[i];
                bool newGroup =
                    (kind == BtnKind.Undo) ||
                    (kind == BtnKind.Copy) ||
                    (kind == BtnKind.Cancel);
                if (newGroup)
                {
                    groupRects.Add(new Rectangle(x + 2, pad + 5, 1, size - 10));
                    x += groupGap;
                }
                buttonRects.Add(new Rectangle(x, pad, size, size));
                x += size + gap;
            }

            int width = x - gap + pad;
            int height = size + pad * 2;

            Rectangle screen = SystemInformation.VirtualScreen;
            int right = hasSel ? sel.Right : (screen.Left + screen.Width);
            int left = right - width;
            if (left + width > screen.Right - 8) left = screen.Right - 8 - width;
            if (left < screen.Left + 8) left = screen.Left + 8;

            int top = hasSel ? sel.Bottom + 8 : screen.Bottom - height - 40;
            if (top + height > screen.Bottom - 8) top = (hasSel ? sel.Top : screen.Bottom) - 8 - height;
            if (top < screen.Top + 8) top = screen.Top + 8;

            panel = new Rectangle(left, top, width, height);
            for (int i = 0; i < buttonRects.Count; i++) { Rectangle r = buttonRects[i]; r.Offset(panel.Left, panel.Top); buttonRects[i] = r; }
            for (int i = 0; i < groupRects.Count; i++) { Rectangle r = groupRects[i]; r.Offset(panel.Left, panel.Top); groupRects[i] = r; }

            palettePanel = Rectangle.Empty;
            if (!ShowPalette) return;

            const int cell = 22;
            const int swatch = 18;
            const int rowHeight = 34;
            int rowWidth = pad * 2 + Palette.Length * cell + 10 + Widths.Length * 26;

            int rowLeft = right - rowWidth;
            if (rowLeft + rowWidth > screen.Right - 8) rowLeft = screen.Right - 8 - rowWidth;
            if (rowLeft < screen.Left + 8) rowLeft = screen.Left + 8;

            int rowTop = panel.Bottom + 6;
            if (rowTop + rowHeight > screen.Bottom - 8) rowTop = panel.Top - 6 - rowHeight;
            if (rowTop < screen.Top + 8) rowTop = screen.Top + 8;

            palettePanel = new Rectangle(rowLeft, rowTop, rowWidth, rowHeight);

            int cx = palettePanel.Left + pad;
            int cy = palettePanel.Top + (rowHeight - swatch) / 2;
            for (int i = 0; i < Palette.Length; i++)
            {
                swatchRects.Add(new Rectangle(cx, cy, swatch, swatch));
                cx += cell;
            }
            cx += 10;
            for (int i = 0; i < Widths.Length; i++)
            {
                widthRects.Add(new Rectangle(cx, palettePanel.Top + 5, 24, rowHeight - 10));
                cx += 26;
            }
        }

        /* ---------------------------------------------------------------- *
         * Window detection
         * ---------------------------------------------------------------- */
        Rectangle? WindowUnder(Point point)
        {
            IntPtr found = IntPtr.Zero;
            Rectangle foundRect = Rectangle.Empty;

            EnumProc callback = delegate(IntPtr hwnd, IntPtr param)
            {
                if (hwnd == Handle) return true;
                if (!IsWindowVisible(hwnd)) return true;
                int style = GetWindowLong(hwnd, GWL_EXSTYLE);
                if ((style & WS_EX_TOOLWINDOW) != 0) return true;
                if ((style & WS_EX_NOACTIVATE) != 0) return true;

                Rectangle rect;
                if (!WindowBounds(hwnd, out rect)) return true;
                if (rect.Width < 16 || rect.Height < 16) return true;
                if (!rect.Contains(point)) return true;

                found = hwnd;
                foundRect = rect;
                return false;
            };

            EnumWindows(callback, IntPtr.Zero);
            return found == IntPtr.Zero ? (Rectangle?)null : foundRect;
        }

        static bool WindowBounds(IntPtr hwnd, out Rectangle rect)
        {
            rect = Rectangle.Empty;
            RECT bounds;
            if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out bounds, Marshal.SizeOf(typeof(RECT))) == 0
                && bounds.Right > bounds.Left + 8 && bounds.Bottom > bounds.Top + 8)
            {
                rect = Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
                return true;
            }
            if (!GetWindowRect(hwnd, out bounds)) return false;
            rect = Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
            return true;
        }

        /* ---------------------------------------------------------------- *
         * Painting
         * ---------------------------------------------------------------- */
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(full, 0, 0);

            if (!hasSel)
            {
                bool live = selecting && dragging && sel.Width > 4 && sel.Height > 4;
                Rectangle keep = Rectangle.Empty;
                if (live) keep = Rectangle.Intersect(sel, ClientRectangle);
                else if (hasHover && hover.Width > 0) keep = Rectangle.Intersect(hover, ClientRectangle);

                if (keep.Width > 0 && keep.Height > 0)
                {
                    DimOutside(g, keep, 140);
                    using (SolidBrush glow = new SolidBrush(Color.FromArgb(live ? 10 : 30, Frame)))
                        g.FillRectangle(glow, keep);
                    using (Pen frame = new Pen(Frame, 2.5f))
                        g.DrawRectangle(frame, keep.Left, keep.Top, keep.Width - 1, keep.Height - 1);
                    if (live) DrawSizeBadge(g, keep);
                }
                else
                {
                    using (SolidBrush dim = new SolidBrush(Color.FromArgb(90, 0, 0, 0)))
                        g.FillRectangle(dim, ClientRectangle);
                }
                DrawHint(g);
                return;
            }

            using (SolidBrush dim = new SolidBrush(Color.FromArgb(140, 0, 0, 0)))
                g.FillRectangle(dim, ClientRectangle);
            g.DrawImage(full, sel, sel, GraphicsUnit.Pixel);

            Region saved = g.Clip;
            g.SetClip(sel);
            foreach (Op op in ops) DrawOne(g, op);
            if (pending != null) DrawOne(g, pending);
            g.Clip = saved;

            if (selected != null && ops.Contains(selected)) DrawSelection(g, selected);

            using (Pen frame = new Pen(Frame, 1.5f))
                g.DrawRectangle(frame, sel);
            DrawHandles(g);
            DrawPanel(g);
            DrawPalette(g);
        }

        void DrawSizeBadge(Graphics g, Rectangle area)
        {
            string text = area.Width + " x " + area.Height;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (Font font = new Font("Microsoft YaHei UI", 12f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (SolidBrush ink = new SolidBrush(Color.White))
            using (SolidBrush back = new SolidBrush(Color.FromArgb(210, 24, 26, 32)))
            {
                SizeF size = g.MeasureString(text, font);
                int width = (int)Math.Ceiling(size.Width) + 14;
                int height = (int)Math.Ceiling(size.Height) + 8;
                int left = Math.Max(6, Math.Min(area.Left, ClientSize.Width - width - 6));
                int top = area.Top - height - 6;
                if (top < 6) top = Math.Min(area.Bottom + 6, ClientSize.Height - height - 6);
                Rectangle box = new Rectangle(left, top, width, height);
                using (GraphicsPath path = Rounded(box, 4)) g.FillPath(back, path);
                g.DrawString(text, font, ink, box.Left + 7, box.Top + 4);
            }
        }

        void DrawHint(Graphics g)
        {
            string text = Environment.GetEnvironmentVariable("DSH_EDITOR_HINT");
            if (string.IsNullOrEmpty(text)) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (Font font = new Font("Microsoft YaHei UI", 13f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (SolidBrush ink = new SolidBrush(Color.FromArgb(235, 255, 255, 255)))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                SizeF size = g.MeasureString(text, font);
                int width = (int)Math.Ceiling(size.Width) + 28;
                int height = (int)Math.Ceiling(size.Height) + 16;
                Rectangle box = new Rectangle(
                    (ClientSize.Width - width) / 2,
                    ClientSize.Height - height - 64,
                    width,
                    height);
                using (SolidBrush back = new SolidBrush(Color.FromArgb(200, 24, 26, 32)))
                using (GraphicsPath path = Rounded(box, 6))
                    g.FillPath(back, path);
                g.DrawString(text, font, ink, new RectangleF(box.Left, box.Top, box.Width, box.Height), format);
            }
        }

        void DimOutside(Graphics g, Rectangle keep, int alpha)
        {
            using (SolidBrush dim = new SolidBrush(Color.FromArgb(alpha, 0, 0, 0)))
            {
                int w = ClientSize.Width;
                int h = ClientSize.Height;
                if (keep.Top > 0) g.FillRectangle(dim, 0, 0, w, keep.Top);
                if (keep.Bottom < h) g.FillRectangle(dim, 0, keep.Bottom, w, h - keep.Bottom);
                if (keep.Left > 0) g.FillRectangle(dim, 0, keep.Top, keep.Left, keep.Height);
                if (keep.Right < w) g.FillRectangle(dim, keep.Right, keep.Top, w - keep.Right, keep.Height);
            }
        }

        void DrawSelection(Graphics g, Op op)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            RectangleF box = OpBounds(op);
            using (Pen pen = new Pen(Color.FromArgb(220, Accent), 1.4f))
            {
                pen.DashStyle = DashStyle.Dash;
                g.DrawRectangle(pen, box.X, box.Y, box.Width, box.Height);
            }
            foreach (Point point in OpHandlePoints(op))
            {
                Rectangle dot = new Rectangle(point.X - 4, point.Y - 4, 8, 8);
                using (SolidBrush fill = new SolidBrush(Color.White)) g.FillRectangle(fill, dot);
                using (Pen edge = new Pen(Accent, 1.5f)) g.DrawRectangle(edge, dot);
            }
        }

        void DrawHandles(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            foreach (Point point in HandlePoints())
            {
                Rectangle box = new Rectangle(point.X - 4, point.Y - 4, 8, 8);
                using (SolidBrush fill = new SolidBrush(Color.White)) g.FillRectangle(fill, box);
                using (Pen edge = new Pen(Frame, 1.5f)) g.DrawRectangle(edge, box);
            }
        }

        IEnumerable<Point> HandlePoints()
        {
            int midX = sel.Left + sel.Width / 2;
            int midY = sel.Top + sel.Height / 2;
            yield return new Point(sel.Left, sel.Top);
            yield return new Point(midX, sel.Top);
            yield return new Point(sel.Right, sel.Top);
            yield return new Point(sel.Right, midY);
            yield return new Point(sel.Right, sel.Bottom);
            yield return new Point(midX, sel.Bottom);
            yield return new Point(sel.Left, sel.Bottom);
            yield return new Point(sel.Left, midY);
        }

        static RectangleF OpBounds(Op op)
        {
            switch (op.Kind)
            {
                case ToolKind.Line:
                case ToolKind.Arrow:
                    return RectangleF.FromLTRB(Math.Min(op.Start.X, op.End.X), Math.Min(op.Start.Y, op.End.Y),
                        Math.Max(op.Start.X, op.End.X), Math.Max(op.Start.Y, op.End.Y));
                case ToolKind.Pen:
                    if (op.Points.Count == 0) return op.Rect;
                    float minX = float.MaxValue, minY = float.MaxValue, maxX = float.MinValue, maxY = float.MinValue;
                    foreach (PointF p in op.Points)
                    {
                        minX = Math.Min(minX, p.X); minY = Math.Min(minY, p.Y);
                        maxX = Math.Max(maxX, p.X); maxY = Math.Max(maxY, p.Y);
                    }
                    return RectangleF.FromLTRB(minX, minY, maxX, maxY);
                default:
                    return op.Rect;
            }
        }

        List<Point> OpHandlePoints(Op op)
        {
            List<Point> list = new List<Point>();
            if (op.Kind == ToolKind.Line || op.Kind == ToolKind.Arrow)
            {
                list.Add(Point.Round(op.Start));
                list.Add(Point.Round(op.End));
                return list;
            }
            RectangleF box = OpBounds(op);
            int midX = (int)(box.Left + box.Width / 2);
            int midY = (int)(box.Top + box.Height / 2);
            list.Add(new Point((int)box.Left, (int)box.Top));
            list.Add(new Point(midX, (int)box.Top));
            list.Add(new Point((int)box.Right, (int)box.Top));
            list.Add(new Point((int)box.Right, midY));
            list.Add(new Point((int)box.Right, (int)box.Bottom));
            list.Add(new Point(midX, (int)box.Bottom));
            list.Add(new Point((int)box.Left, (int)box.Bottom));
            list.Add(new Point((int)box.Left, midY));
            return list;
        }

        static void DrawOne(Graphics g, Op op)
        {
            if (op.Snapshot != null) { g.DrawImage(op.Snapshot, op.Rect); return; }
            if (op.Kind == ToolKind.Mosaic)
            {
                using (Pen dashed = new Pen(Color.FromArgb(220, 255, 255, 255), 1f))
                {
                    dashed.DashStyle = DashStyle.Dash;
                    g.DrawRectangle(dashed, op.Rect.X, op.Rect.Y, op.Rect.Width, op.Rect.Height);
                }
                return;
            }
            DrawOp(g, op, 1f);
        }

        static void DrawOp(Graphics g, Op op, float scale)
        {
            using (Pen pen = new Pen(op.Color, Math.Max(1f, op.Width * scale)))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                switch (op.Kind)
                {
                    case ToolKind.Rect:
                        g.DrawRectangle(pen, op.Rect.X, op.Rect.Y, op.Rect.Width, op.Rect.Height);
                        break;
                    case ToolKind.Ellipse:
                        g.DrawEllipse(pen, op.Rect.X, op.Rect.Y, op.Rect.Width, op.Rect.Height);
                        break;
                    case ToolKind.Line:
                        g.DrawLine(pen, op.Start, op.End);
                        break;
                    case ToolKind.Arrow:
                        g.DrawLine(pen, op.Start, op.End);
                        DrawHead(g, pen, op.Start, op.End, op.Width, scale);
                        break;
                    case ToolKind.Pen:
                        if (op.Points.Count > 1) g.DrawLines(pen, op.Points.ToArray());
                        break;
                    case ToolKind.Text:
                        using (Font font = new Font("Microsoft YaHei UI", TextPx(op.Width) * scale, FontStyle.Regular, GraphicsUnit.Pixel))
                        using (SolidBrush fill = new SolidBrush(op.Color))
                        {
                            g.DrawString(op.Text ?? string.Empty, font, fill, op.Rect.X, op.Rect.Y);
                        }
                        break;
                }
            }
        }

        static void DrawHead(Graphics g, Pen pen, PointF from, PointF to, float width, float scale)
        {
            double angle = Math.Atan2(to.Y - from.Y, to.X - from.X);
            float head = Math.Max(12f, width * 4f * scale);
            PointF left = new PointF(
                (float)(to.X + Math.Cos(angle + Math.PI - 0.42) * head),
                (float)(to.Y + Math.Sin(angle + Math.PI - 0.42) * head));
            PointF right = new PointF(
                (float)(to.X + Math.Cos(angle + Math.PI + 0.42) * head),
                (float)(to.Y + Math.Sin(angle + Math.PI + 0.42) * head));
            using (SolidBrush fill = new SolidBrush(pen.Color))
            using (GraphicsPath path = new GraphicsPath())
            {
                path.AddPolygon(new PointF[] { to, left, right });
                g.FillPath(fill, path);
            }
        }

        void DrawPanel(Graphics g)
        {
            if (!hasSel) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = Rounded(panel, 8))
            {
                using (SolidBrush shadow = new SolidBrush(Color.FromArgb(38, 0, 0, 0)))
                {
                    Rectangle shifted = panel;
                    shifted.Offset(0, 2);
                    using (GraphicsPath below = Rounded(shifted, 8)) g.FillPath(shadow, below);
                }
                using (SolidBrush fill = new SolidBrush(Color.FromArgb(252, 255, 255, 255))) g.FillPath(fill, path);
                using (Pen border = new Pen(Color.FromArgb(24, 0, 0, 0))) g.DrawPath(border, path);
            }

            for (int i = 0; i < buttons.Count; i++)
            {
                Rectangle r = buttonRects[i];
                bool active = IsActive(buttons[i]);
                bool enabled = IsEnabled(buttons[i]);
                if (active)
                {
                    using (SolidBrush on = new SolidBrush(Color.FromArgb(255, 232, 240, 254)))
                    using (GraphicsPath p = Rounded(r, 5)) g.FillPath(on, p);
                }
                else if (hoverIndex == i && enabled)
                {
                    using (SolidBrush hot = new SolidBrush(Color.FromArgb(255, 242, 243, 245)))
                    using (GraphicsPath p = Rounded(r, 5)) g.FillPath(hot, p);
                }
                DrawIcon(g, buttons[i], r, active, enabled);
            }

            foreach (Rectangle gr in groupRects)
            {
                using (Pen sep = new Pen(Color.FromArgb(229, 229, 229), 1f))
                    g.DrawLine(sep, gr.Left, gr.Top, gr.Left, gr.Bottom);
            }
        }

        void DrawPalette(Graphics g)
        {
            if (palettePanel.IsEmpty) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = Rounded(palettePanel, 8))
            {
                using (SolidBrush fill = new SolidBrush(Color.FromArgb(252, 255, 255, 255))) g.FillPath(fill, path);
                using (Pen border = new Pen(Color.FromArgb(24, 0, 0, 0))) g.DrawPath(border, path);
            }

            for (int i = 0; i < swatchRects.Count; i++)
            {
                Rectangle r = swatchRects[i];
                using (SolidBrush b = new SolidBrush(Palette[i])) g.FillEllipse(b, r);
                using (Pen hair = new Pen(Color.FromArgb(28, 0, 0, 0), 1f)) g.DrawEllipse(hair, r);
                if (Palette[i].ToArgb() == color.ToArgb())
                {
                    Rectangle ring = r;
                    ring.Inflate(3, 3);
                    using (Pen pen = new Pen(Accent, 1.6f)) g.DrawEllipse(pen, ring);
                }
            }

            for (int i = 0; i < widthRects.Count; i++)
            {
                Rectangle r = widthRects[i];
                bool on = Math.Abs(Widths[i] - strokeWidth) < 0.1f;
                if (on)
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 232, 240, 254)))
                    using (GraphicsPath p = Rounded(r, 4)) g.FillPath(b, p);
                }
                if (TextMode)
                {
                    string caption = i == 0 ? "小" : (i == 1 ? "中" : "大");
                    float px = i == 0 ? 10f : (i == 1 ? 12.5f : 15f);
                    using (Font font = new Font("Microsoft YaHei UI", px, FontStyle.Regular, GraphicsUnit.Pixel))
                    using (SolidBrush b = new SolidBrush(on ? Accent : Color.FromArgb(70, 70, 70)))
                    using (StringFormat sf = new StringFormat())
                    {
                        sf.Alignment = StringAlignment.Center;
                        sf.LineAlignment = StringAlignment.Center;
                        g.DrawString(caption, font, b, new RectangleF(r.Left, r.Top, r.Width, r.Height), sf);
                    }
                }
                else
                {
                    float dot = 2f + i * 2f;
                    using (SolidBrush b = new SolidBrush(on ? Accent : Color.FromArgb(90, 90, 90)))
                    {
                        float cy = r.Top + r.Height / 2f;
                        g.FillEllipse(b, r.Left + r.Width / 2f - dot, cy - dot, dot * 2, dot * 2);
                    }
                }
            }
        }

        bool TextMode
        {
            get { return tool == ToolKind.Text || (selected != null && selected.Kind == ToolKind.Text); }
        }

        static float TextPx(float width)
        {
            if (width <= 3f) return 18f;
            if (width <= 6f) return 28f;
            return 44f;
        }

        static void Log(string message)
        {
            try
            {
                string path = Environment.GetEnvironmentVariable("DSH_EDITOR_LOG");
                if (string.IsNullOrEmpty(path)) return;
                File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
            catch
            {
            }
        }

        static GraphicsPath Rounded(Rectangle r, int radius)
        {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(r.Left, r.Top, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        bool IsActive(BtnKind kind)
        {
            switch (kind)
            {
                case BtnKind.Rect: return tool == ToolKind.Rect;
                case BtnKind.Ellipse: return tool == ToolKind.Ellipse;
                case BtnKind.Line: return tool == ToolKind.Line;
                case BtnKind.Arrow: return tool == ToolKind.Arrow;
                case BtnKind.Pen: return tool == ToolKind.Pen;
                case BtnKind.Mosaic: return tool == ToolKind.Mosaic;
                case BtnKind.Text: return tool == ToolKind.Text;
                default: return false;
            }
        }

        bool IsEnabled(BtnKind kind)
        {
            if (kind == BtnKind.Undo) return ops.Count > 0;
            if (kind == BtnKind.Redo) return redo.Count > 0;
            return true;
        }

        void DrawIcon(Graphics g, BtnKind kind, Rectangle r, bool active, bool enabled)
        {
            Color ink;
            if (kind == BtnKind.Cancel) ink = Color.FromArgb(230, 72, 77);
            else if (kind == BtnKind.Confirm) ink = Color.FromArgb(18, 183, 106);
            else if (!enabled) ink = Color.FromArgb(198, 198, 198);
            else if (active) ink = Accent;
            else ink = Color.FromArgb(51, 51, 51);

            float cx = r.Left + r.Width / 2f;
            float cy = r.Top + r.Height / 2f;
            using (Pen pen = new Pen(ink, 1.7f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                switch (kind)
                {
                    case BtnKind.Rect:
                        g.DrawRectangle(pen, cx - 7, cy - 5.5f, 14, 11);
                        break;
                    case BtnKind.Ellipse:
                        g.DrawEllipse(pen, cx - 7, cy - 5.5f, 14, 11);
                        break;
                    case BtnKind.Line:
                        g.DrawLine(pen, cx - 7, cy + 6, cx + 7, cy - 6);
                        break;
                    case BtnKind.Arrow:
                        g.DrawLine(pen, cx - 7, cy + 6, cx + 5, cy - 5);
                        g.DrawLine(pen, cx + 5, cy - 5, cx, cy - 5);
                        g.DrawLine(pen, cx + 5, cy - 5, cx + 5, cy);
                        break;
                    case BtnKind.Pen:
                        using (GraphicsPath path = new GraphicsPath())
                        {
                            path.AddBezier(cx - 8, cy + 5, cx - 3, cy - 9, cx + 2, cy + 9, cx + 8, cy - 5);
                            g.DrawPath(pen, path);
                        }
                        break;
                    case BtnKind.Mosaic:
                        for (int i = 0; i < 3; i++)
                            for (int j = 0; j < 3; j++)
                                if ((i + j) % 2 == 0)
                                    using (SolidBrush b = new SolidBrush(ink))
                                        g.FillRectangle(b, cx - 7 + i * 5, cy - 6 + j * 4, 4, 3);
                        using (Pen box = new Pen(ink, 1.1f)) g.DrawRectangle(box, cx - 7, cy - 6, 14, 12);
                        break;
                    case BtnKind.Text:
                        using (Font font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point))
                        using (SolidBrush b = new SolidBrush(ink))
                        using (StringFormat sf = new StringFormat())
                        {
                            sf.Alignment = StringAlignment.Center;
                            sf.LineAlignment = StringAlignment.Center;
                            g.DrawString("T", font, b, new RectangleF(r.Left, r.Top - 1, r.Width, r.Height), sf);
                        }
                        break;
                    case BtnKind.Undo:
                        using (GraphicsPath path = new GraphicsPath())
                        {
                            path.AddArc(cx - 7, cy - 5, 14, 11, 200, 220);
                            g.DrawPath(pen, path);
                        }
                        g.DrawLine(pen, cx - 8, cy - 3, cx - 8, cy + 3);
                        break;
                    case BtnKind.Redo:
                        using (GraphicsPath path = new GraphicsPath())
                        {
                            path.AddArc(cx - 7, cy - 5, 14, 11, -20, -220);
                            g.DrawPath(pen, path);
                        }
                        g.DrawLine(pen, cx + 8, cy - 3, cx + 8, cy + 3);
                        break;
                    case BtnKind.Copy:
                        using (Pen back = new Pen(ink, 1.5f)) g.DrawRectangle(back, cx - 8, cy - 7, 10, 10);
                        using (Pen front = new Pen(ink, 1.5f)) g.DrawRectangle(front, cx - 3, cy - 2, 10, 10);
                        break;
                    case BtnKind.Save:
                        g.DrawLine(pen, cx, cy - 7, cx, cy + 2);
                        g.DrawLine(pen, cx, cy + 2, cx - 4, cy - 2);
                        g.DrawLine(pen, cx, cy + 2, cx + 4, cy - 2);
                        g.DrawLine(pen, cx - 7, cy + 7, cx + 7, cy + 7);
                        break;
                    case BtnKind.Cancel:
                        g.DrawLine(pen, cx - 5, cy - 5, cx + 5, cy + 5);
                        g.DrawLine(pen, cx + 5, cy - 5, cx - 5, cy + 5);
                        break;
                    case BtnKind.Confirm:
                        using (Pen thick = new Pen(ink, 2.3f))
                        {
                            g.DrawLine(thick, cx - 7, cy + 0.5f, cx - 2, cy + 6);
                            g.DrawLine(thick, cx - 2, cy + 6, cx + 8, cy - 6);
                        }
                        break;
                }
            }
        }

        /* ---------------------------------------------------------------- *
         * Input
         * ---------------------------------------------------------------- */
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);

            if (!hasSel)
            {
                if (dragging && selecting)
                {
                    // Live region drag before the selection is committed: keep the
                    // rectangle under the cursor bright and dim everything else.
                    sel = Normalize(dragStart, e.Location);
                    hasHover = false;
                    hover = Rectangle.Empty;
                    Cursor = Cursors.Cross;
                    Invalidate();
                    return;
                }

                Rectangle? under = WindowUnder(e.Location);
                Rectangle next = under.HasValue ? Clip(under.Value) : Rectangle.Empty;
                bool show = under.HasValue;
                if (show != hasHover || next != hover)
                {
                    hasHover = show;
                    hover = next;
                    Log("hover " + (show ? hover.ToString() : "none") + " at " + e.Location);
                    Invalidate();
                }
                Cursor = Cursors.Cross;
                return;
            }

            if (dragging)
            {
                if (selecting)
                {
                    sel = Normalize(dragStart, e.Location);
                    Recalculate();
                }
                else if (moving && selected != null)
                {
                    Point delta = new Point(e.Location.X - dragStart.X, e.Location.Y - dragStart.Y);
                    MoveOp(selected, delta, dragStart);
                }
                else if (handleIndex >= 0 && selected != null)
                {
                    DragHandle(selected, handleIndex, e.Location);
                }
                else if (zone == Zone.Inside)
                {
                    int dx = e.Location.X - zoneOrigin.X;
                    int dy = e.Location.Y - zoneOrigin.Y;
                    Rectangle moved = zoneBase;
                    moved.Offset(dx, dy);
                    sel = Clip(moved);
                    Recalculate();
                }
                else if (zone != Zone.None)
                {
                    sel = ResizeZone(zoneBase, zone, e.Location);
                    Recalculate();
                }
                else if (pending != null)
                {
                    pending.End = e.Location;
                    if (pending.Kind == ToolKind.Pen) pending.Points.Add(e.Location);
                    else pending.Rect = Normalize(dragStart, e.Location);
                }
                Invalidate();
                return;
            }

            int index = -1;
            for (int i = 0; i < buttonRects.Count; i++)
                if (buttonRects[i].Contains(e.Location) && IsEnabled(buttons[i])) index = i;
            if (index != hoverIndex) { hoverIndex = index; Invalidate(); }

            Cursor = CursorFor(e.Location);
        }

        Cursor CursorFor(Point point)
        {
            if (selected != null)
            {
                int hit = HandleAt(selected, point);
                if (hit >= 0) return Cursors.Cross;
            }
            Zone hitZone = ZoneAt(point);
            switch (hitZone)
            {
                case Zone.Left:
                case Zone.Right: return Cursors.SizeWE;
                case Zone.Top:
                case Zone.Bottom: return Cursors.SizeNS;
                case Zone.TopLeft:
                case Zone.BottomRight: return Cursors.SizeNWSE;
                case Zone.TopRight:
                case Zone.BottomLeft: return Cursors.SizeNESW;
                case Zone.Inside: return tool == ToolKind.None ? Cursors.SizeAll : Cursors.Cross;
                default: return sel.Contains(point) ? Cursors.Cross : Cursors.Default;
            }
        }

        Zone ZoneAt(Point point)
        {
            if (!hasSel) return Zone.None;
            const int grip = 7;
            bool left = Math.Abs(point.X - sel.Left) <= grip;
            bool right = Math.Abs(point.X - sel.Right) <= grip;
            bool top = Math.Abs(point.Y - sel.Top) <= grip;
            bool bottom = Math.Abs(point.Y - sel.Bottom) <= grip;
            bool insideY = point.Y >= sel.Top - grip && point.Y <= sel.Bottom + grip;
            bool insideX = point.X >= sel.Left - grip && point.X <= sel.Right + grip;

            if (left && top) return Zone.TopLeft;
            if (right && top) return Zone.TopRight;
            if (left && bottom) return Zone.BottomLeft;
            if (right && bottom) return Zone.BottomRight;
            if (left && insideY) return Zone.Left;
            if (right && insideY) return Zone.Right;
            if (top && insideX) return Zone.Top;
            if (bottom && insideX) return Zone.Bottom;
            if (sel.Contains(point)) return Zone.Inside;
            return Zone.None;
        }

        int HandleAt(Op op, Point point)
        {
            List<Point> handles = OpHandlePoints(op);
            for (int i = 0; i < handles.Count; i++)
            {
                if (Math.Abs(handles[i].X - point.X) <= 7 && Math.Abs(handles[i].Y - point.Y) <= 7) return i;
            }
            return -1;
        }

        Op HitOp(Point point)
        {
            for (int i = ops.Count - 1; i >= 0; i--)
            {
                Op op = ops[i];
                if (op.Kind == ToolKind.Line || op.Kind == ToolKind.Arrow)
                {
                    if (DistanceToSegment(point, op.Start, op.End) <= 9) return op;
                    continue;
                }
                RectangleF box = OpBounds(op);
                box.Inflate(6, 6);
                if (box.Contains(point)) return op;
            }
            return null;
        }

        static float DistanceToSegment(Point p, PointF a, PointF b)
        {
            float dx = b.X - a.X;
            float dy = b.Y - a.Y;
            float length = dx * dx + dy * dy;
            if (length < 0.0001f) return Distance(p, a);
            float t = ((p.X - a.X) * dx + (p.Y - a.Y) * dy) / length;
            t = Math.Max(0f, Math.Min(1f, t));
            return Distance(p, new PointF(a.X + t * dx, a.Y + t * dy));
        }

        static float Distance(Point p, PointF q)
        {
            float dx = q.X - p.X;
            float dy = q.Y - p.Y;
            return (float)Math.Sqrt(dx * dx + dy * dy);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            CommitText();

            if (e.Button == MouseButtons.Right)
            {
                if (hasSel) Undo();
                else Finish("cancel");
                return;
            }
            if (e.Button != MouseButtons.Left) return;

            for (int i = 0; i < buttonRects.Count; i++)
            {
                if (buttonRects[i].Contains(e.Location))
                {
                    if (IsEnabled(buttons[i])) Press(buttons[i]);
                    return;
                }
            }
            for (int i = 0; i < swatchRects.Count; i++)
            {
                if (swatchRects[i].Contains(e.Location))
                {
                    color = Palette[i];
                    if (selected != null) selected.Color = color;
                    Invalidate();
                    return;
                }
            }
            for (int i = 0; i < widthRects.Count; i++)
            {
                if (widthRects[i].Contains(e.Location))
                {
                    strokeWidth = Widths[i];
                    if (selected != null) selected.Width = strokeWidth;
                    Invalidate();
                    return;
                }
            }

            if (!hasSel)
            {
                dragStart = e.Location;
                dragging = true;
                selecting = true;
                hasHover = false;
                hover = Rectangle.Empty;
                sel = new Rectangle(e.Location.X, e.Location.Y, 0, 0);
                Invalidate();
                return;
            }

            if (selected != null)
            {
                int hit = HandleAt(selected, e.Location);
                if (hit >= 0)
                {
                    handleIndex = hit;
                    handleBase = selected;
                    dragging = true;
                    selecting = false;
                    moving = false;
                    return;
                }
            }

            Zone hitZone = ZoneAt(e.Location);
            if (hitZone != Zone.None && hitZone != Zone.Inside)
            {
                zone = hitZone;
                zoneBase = sel;
                dragging = true;
                selecting = false;
                return;
            }

            if (tool == ToolKind.None)
            {
                Op hit = HitOp(e.Location);
                if (hit != null)
                {
                    selected = hit;
                    dragging = true;
                    moving = true;
                    CaptureMove(hit, e.Location);
                    Invalidate();
                    return;
                }
                if (selected != null) { selected = null; Invalidate(); }
                if (hitZone == Zone.Inside)
                {
                    zone = Zone.Inside;
                    zoneBase = sel;
                    zoneOrigin = e.Location;
                    dragging = true;
                    return;
                }
                return;
            }

            if (hitZone != Zone.Inside) return;

            if (tool == ToolKind.Text) { BeginText(e.Location); return; }

            zone = Zone.None;
            dragging = true;
            dragStart = e.Location;
            pending = new Op();
            pending.Kind = tool;
            pending.Color = color;
            pending.Width = strokeWidth;
            pending.Start = e.Location;
            pending.End = e.Location;
            if (tool == ToolKind.Pen) pending.Points.Add(e.Location);
            Invalidate();
        }

        Op handleBase;

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!dragging) return;
            dragging = false;
            handleIndex = -1;
            moving = false;

            if (selecting)
            {
                selecting = false;
                Rectangle drawn = Normalize(dragStart, e.Location);
                if (drawn.Width > 8 && drawn.Height > 8)
                {
                    sel = Clip(drawn);
                    hasSel = true;
                }
                else if (hasHover)
                {
                    sel = hover;
                    hasSel = sel.Width > 8 && sel.Height > 8;
                }
                if (hasSel) Recalculate();
                Invalidate();
                return;
            }

            if (pending == null) { Invalidate(); return; }

            bool tiny = pending.Kind == ToolKind.Pen
                ? pending.Points.Count < 2
                : (pending.Kind == ToolKind.Line || pending.Kind == ToolKind.Arrow)
                    ? Distance(Point.Round(pending.Start), pending.End) < 6
                    : pending.Rect.Width < 4 && pending.Rect.Height < 4;

            if (tiny) { pending = null; Invalidate(); return; }

            if (pending.Kind == ToolKind.Mosaic)
            {
                RectangleF area = ClipTo(pending.Rect);
                if (area.Width >= 4 && area.Height >= 4)
                {
                    Bitmap patch = Mosaic(full, area, 1f);
                    if (patch != null) { pending.Rect = area; pending.Snapshot = patch; redo.Clear(); ops.Add(pending); selected = pending; }
                }
                pending = null;
                Invalidate();
                return;
            }

            if (pending.Kind == ToolKind.Pen) pending.Rect = ClipTo(pending.Rect);
            redo.Clear();
            ops.Add(pending);
            selected = pending;
            pending = null;
            if (ShapeTool) tool = ToolKind.None;
            Recalculate();
            Invalidate();
        }

        void MoveOp(Op op, Point delta, Point origin)
        {
            if (moveBase == null) return;
            float dx = delta.X;
            float dy = delta.Y;
            switch (op.Kind)
            {
                case ToolKind.Line:
                case ToolKind.Arrow:
                    op.Start = new PointF(moveBase.Start.X + dx, moveBase.Start.Y + dy);
                    op.End = new PointF(moveBase.End.X + dx, moveBase.End.Y + dy);
                    break;
                case ToolKind.Pen:
                    for (int i = 0; i < op.Points.Count && i < moveBase.Points.Count; i++)
                        op.Points[i] = new PointF(moveBase.Points[i].X + dx, moveBase.Points[i].Y + dy);
                    break;
                default:
                    op.Rect = new RectangleF(moveBase.Rect.X + dx, moveBase.Rect.Y + dy, moveBase.Rect.Width, moveBase.Rect.Height);
                    break;
            }
            Invalidate();
        }

        void CaptureMove(Op op, Point origin)
        {
            moveBase = new Op
            {
                Kind = op.Kind,
                Rect = op.Rect,
                Start = op.Start,
                End = op.End,
                Points = new List<PointF>(op.Points)
            };
            dragStart = origin;
        }

        void DragHandle(Op op, int index, Point point)
        {
            if (op.Kind == ToolKind.Line || op.Kind == ToolKind.Arrow)
            {
                if (index == 0) op.Start = point;
                else op.End = point;
                Invalidate();
                return;
            }
            RectangleF box = OpBounds(op);
            float left = box.Left, top = box.Top, right = box.Right, bottom = box.Bottom;
            switch (index)
            {
                case 0: left = point.X; top = point.Y; break;
                case 1: top = point.Y; break;
                case 2: right = point.X; top = point.Y; break;
                case 3: right = point.X; break;
                case 4: right = point.X; bottom = point.Y; break;
                case 5: bottom = point.Y; break;
                case 6: left = point.X; bottom = point.Y; break;
                case 7: left = point.X; break;
            }
            RectangleF next = RectangleF.FromLTRB(Math.Min(left, right), Math.Min(top, bottom), Math.Max(left, right), Math.Max(top, bottom));
            if (next.Width < 8) next.Width = 8;
            if (next.Height < 8) next.Height = 8;

            if (op.Kind == ToolKind.Pen)
            {
                float sx = box.Width < 1 ? 1 : next.Width / box.Width;
                float sy = box.Height < 1 ? 1 : next.Height / box.Height;
                for (int i = 0; i < op.Points.Count; i++)
                {
                    op.Points[i] = new PointF(next.Left + (op.Points[i].X - box.Left) * sx, next.Top + (op.Points[i].Y - box.Top) * sy);
                }
            }
            else
            {
                op.Rect = next;
            }
            Invalidate();
        }

        static Rectangle Normalize(Point a, Point b)
        {
            return Rectangle.FromLTRB(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y));
        }

        Rectangle ResizeZone(Rectangle baseRect, Zone zone, Point point)
        {
            int left = baseRect.Left;
            int top = baseRect.Top;
            int right = baseRect.Right;
            int bottom = baseRect.Bottom;

            if (zone == Zone.Left || zone == Zone.TopLeft || zone == Zone.BottomLeft) left = point.X;
            if (zone == Zone.Right || zone == Zone.TopRight || zone == Zone.BottomRight) right = point.X;
            if (zone == Zone.Top || zone == Zone.TopLeft || zone == Zone.TopRight) top = point.Y;
            if (zone == Zone.Bottom || zone == Zone.BottomLeft || zone == Zone.BottomRight) bottom = point.Y;

            Rectangle next = Rectangle.FromLTRB(Math.Min(left, right), Math.Min(top, bottom), Math.Max(left, right), Math.Max(top, bottom));
            if (next.Width < 16) next.Width = 16;
            if (next.Height < 16) next.Height = 16;
            return Clip(next);
        }

        Rectangle Clip(Rectangle rect)
        {
            rect.Intersect(new Rectangle(0, 0, full.Width, full.Height));
            return rect;
        }

        RectangleF ClipTo(RectangleF rect)
        {
            RectangleF area = new RectangleF(sel.X, sel.Y, sel.Width, sel.Height);
            rect.Intersect(area);
            return rect;
        }

        void Undo()
        {
            if (ops.Count == 0) return;
            int last = ops.Count - 1;
            Op op = ops[last];
            if (op == selected) selected = null;
            ops.RemoveAt(last);
            redo.Add(op);
            if (redo.Count > 64) redo.RemoveAt(0);
            Recalculate();
            Invalidate();
        }

        void Redo()
        {
            if (redo.Count == 0) return;
            Op op = redo[redo.Count - 1];
            redo.RemoveAt(redo.Count - 1);
            ops.Add(op);
            selected = op;
            Recalculate();
            Invalidate();
        }

        void Press(BtnKind kind)
        {
            switch (kind)
            {
                case BtnKind.Rect: Toggle(ToolKind.Rect); break;
                case BtnKind.Ellipse: Toggle(ToolKind.Ellipse); break;
                case BtnKind.Line: Toggle(ToolKind.Line); break;
                case BtnKind.Arrow: Toggle(ToolKind.Arrow); break;
                case BtnKind.Pen: Toggle(ToolKind.Pen); break;
                case BtnKind.Mosaic: Toggle(ToolKind.Mosaic); break;
                case BtnKind.Text: Toggle(ToolKind.Text); break;
                case BtnKind.Undo: Undo(); return;
                case BtnKind.Redo: Redo(); return;
                case BtnKind.Copy: Finish("copy"); return;
                case BtnKind.Save: Finish("save"); return;
                case BtnKind.Cancel: Finish("cancel"); return;
                case BtnKind.Confirm: Finish("insert"); return;
            }
            Recalculate();
            Invalidate();
        }

        void Toggle(ToolKind next)
        {
            tool = tool == next ? ToolKind.None : next;
            if (tool != ToolKind.None) selected = null;
            Cursor = tool == ToolKind.None ? Cursors.Default : Cursors.Cross;
        }

        /* ---------------------------------------------------------------- *
         * Text
         * ---------------------------------------------------------------- */
        void BeginText(Point at)
        {
            input = new TextBox();
            input.BorderStyle = BorderStyle.FixedSingle;
            input.BackColor = Color.FromArgb(255, 255, 255);
            input.ForeColor = Color.Black;
            input.Font = new Font("Microsoft YaHei UI", Math.Max(10f, TextPx(strokeWidth) * 0.75f));
            input.Width = 220;
            input.Location = new Point(Math.Min(at.X, sel.Right - 220), Math.Min(at.Y, sel.Bottom - 30));
            textOp = new Op();
            textOp.Kind = ToolKind.Text;
            textOp.Color = color;
            textOp.Width = strokeWidth;
            textOp.Origin = at;
            input.KeyDown += InputKeyDown;
            input.LostFocus += delegate { CommitText(); };
            Controls.Add(input);
            input.Focus();
        }

        void InputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { CommitText(); e.SuppressKeyPress = true; }
            else if (e.KeyCode == Keys.Escape) { CancelText(); e.SuppressKeyPress = true; }
        }

        void CommitText()
        {
            if (input == null) return;
            string value = input.Text;
            TextBox box = input;
            input = null;
            Controls.Remove(box);
            box.Dispose();
            if (textOp != null && !string.IsNullOrEmpty(value))
            {
                Op op = textOp;
                op.Text = value;
                using (Font font = new Font("Microsoft YaHei UI", TextPx(op.Width), FontStyle.Regular, GraphicsUnit.Pixel))
                using (Bitmap scratch = new Bitmap(4, 4))
                using (Graphics measure = Graphics.FromImage(scratch))
                {
                    SizeF size = measure.MeasureString(value, font);
                    op.Rect = new RectangleF(op.Origin.X, op.Origin.Y, Math.Max(4f, size.Width), Math.Max(4f, size.Height));
                }
                redo.Clear();
                ops.Add(op);
                selected = op;
            }
            textOp = null;
            Invalidate();
        }

        void CancelText()
        {
            if (input == null) return;
            TextBox box = input;
            input = null;
            textOp = null;
            Controls.Remove(box);
            box.Dispose();
            Invalidate();
        }

        /* ---------------------------------------------------------------- *
         * Output
         * ---------------------------------------------------------------- */
        Bitmap Compose()
        {
            Bitmap canvas = new Bitmap(sel.Width, sel.Height);
            using (Graphics g = Graphics.FromImage(canvas))
            {
                g.InterpolationMode = InterpolationMode.NearestNeighbor;
                g.PixelOffsetMode = PixelOffsetMode.Half;
                g.DrawImage(full, new Rectangle(0, 0, sel.Width, sel.Height), sel, GraphicsUnit.Pixel);
                g.TranslateTransform(-sel.Left, -sel.Top);
                foreach (Op op in ops) DrawOne(g, op);
            }
            return canvas;
        }

        void Finish(string action)
        {
            CommitText();
            Log("finish " + action + " sel=" + sel + " ops=" + ops.Count);
            try
            {
                if (action == "cancel" || !hasSel)
                {
                    result = new Result { Action = "cancel", Width = 0, Height = 0 };
                    return;
                }
                using (Bitmap image = Compose())
                {
                    if (action == "copy")
                    {
                        for (int attempt = 0; attempt < 3; attempt++)
                        {
                            try { Clipboard.SetImage(image); break; }
                            catch { System.Threading.Thread.Sleep(90); }
                        }
                    }
                    else if (action == "save")
                    {
                        using (SaveFileDialog dialog = new SaveFileDialog())
                        {
                            dialog.Filter = "PNG|*.png|JPEG|*.jpg|BMP|*.bmp";
                            dialog.FileName = "screenshot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png";
                            if (dialog.ShowDialog(this) == DialogResult.Cancel)
                            {
                                result = new Result { Action = "cancel", Width = 0, Height = 0 };
                                return;
                            }
                            if (dialog.FileName.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase))
                            {
                                using (Bitmap flat = new Bitmap(image.Width, image.Height))
                                {
                                    using (Graphics g = Graphics.FromImage(flat)) { g.Clear(Color.White); g.DrawImage(image, 0, 0); }
                                    flat.Save(dialog.FileName, ImageFormat.Jpeg);
                                }
                            }
                            else if (dialog.FileName.EndsWith(".bmp", StringComparison.OrdinalIgnoreCase))
                            {
                                image.Save(dialog.FileName, ImageFormat.Bmp);
                            }
                            else
                            {
                                image.Save(dialog.FileName, ImageFormat.Png);
                            }
                        }
                    }
                    else
                    {
                        image.Save(outPath, ImageFormat.Png);
                    }
                    result = new Result { Action = action, Width = sel.Width, Height = sel.Height };
                }
            }
            finally
            {
                Close();
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Activate();
            Log("shown bounds=" + ClientSize.Width + "x" + ClientSize.Height + " sel=" + sel + " cursor=" + Cursor.Position);
            if (selfTest)
            {
                hasSel = true;
                AddSamples();
                tick = new Timer();
                tick.Interval = 900;
                tick.Tick += delegate { tick.Stop(); Finish("insert"); };
                tick.Start();
            }
            string presetTool = Environment.GetEnvironmentVariable("DSH_EDITOR_TOOL");
            if (!string.IsNullOrEmpty(presetTool))
            {
                switch (presetTool)
                {
                    case "rect": tool = ToolKind.Rect; break;
                    case "ellipse": tool = ToolKind.Ellipse; break;
                    case "line": tool = ToolKind.Line; break;
                    case "arrow": tool = ToolKind.Arrow; break;
                    case "pen": tool = ToolKind.Pen; break;
                    case "mosaic": tool = ToolKind.Mosaic; break;
                    case "text": tool = ToolKind.Text; break;
                }
                Recalculate();
                Invalidate();
            }
            string script = Environment.GetEnvironmentVariable("DSH_EDITOR_SCRIPT");
            if (script == "interact")
            {
                Op shape = new Op { Kind = ToolKind.Rect, Rect = new Rectangle(sel.Left + 60, sel.Top + 60, 260, 150), Color = Palette[0], Width = 4f };
                ops.Add(shape);
                ops.Add(new Op
                {
                    Kind = ToolKind.Arrow,
                    Start = new PointF(sel.Left + 380, sel.Top + 320),
                    End = new PointF(sel.Left + 660, sel.Top + 190),
                    Color = Palette[3],
                    Width = 4f
                });
                selected = shape;
                if (Environment.GetEnvironmentVariable("DSH_EDITOR_RESIZE") == "1")
                    DragHandle(shape, 4, new Point((int)shape.Rect.Right + 90, (int)shape.Rect.Bottom + 45));
                if (Environment.GetEnvironmentVariable("DSH_EDITOR_UNDO") == "1") Undo();
                tool = ToolKind.None;
                Recalculate();
                Invalidate();
            }
            if (Environment.GetEnvironmentVariable("DSH_EDITOR_PICKDRAG") == "1")
            {
                hasSel = false;
                dragStart = new Point(420, 300);
                selecting = true;
                dragging = true;
                sel = Normalize(dragStart, new Point(1460, 860));
                Invalidate();
            }
            string diag = Environment.GetEnvironmentVariable("DSH_EDITOR_DIAG");
            if (string.IsNullOrEmpty(diag)) return;
            try
            {
                using (Bitmap shot = new Bitmap(ClientSize.Width, ClientSize.Height))
                {
                    DrawToBitmap(shot, new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));
                    shot.Save(diag + ".png", ImageFormat.Png);
                }
                System.IO.File.WriteAllText(diag + ".txt",
                    "bounds=" + Bounds.ToString() + " client=" + ClientSize.ToString() +
                    " sel=" + sel.ToString() + " panel=" + panel.ToString()
                    + " palette=" + palettePanel.ToString() + " tool=" + tool);
            }
            catch (Exception error)
            {
                System.IO.File.WriteAllText(diag + ".txt", "diag failed: " + error.Message);
            }
        }

        void AddSamples()
        {
            Rectangle area = Rectangle.Inflate(sel, -24, -24);
            if (area.Width < 160 || area.Height < 160) area = sel;
            int w = Math.Max(60, area.Width / 3);
            int h = Math.Max(40, area.Height / 3);

            ops.Add(new Op { Kind = ToolKind.Rect, Rect = new Rectangle(area.Left, area.Top, w, h), Color = Palette[0], Width = 4f });
            ops.Add(new Op { Kind = ToolKind.Ellipse, Rect = new Rectangle(area.Left + w + 24, area.Top, w, h), Color = Palette[2], Width = 4f });
            ops.Add(new Op { Kind = ToolKind.Line, Start = new PointF(area.Left, area.Top + h + 50), End = new PointF(area.Left + w + 40, area.Top + h + 120), Color = Palette[4], Width = 4f });
            ops.Add(new Op { Kind = ToolKind.Arrow, Start = new PointF(area.Left + w + 90, area.Top + h + 130), End = new PointF(area.Left + 20, area.Top + h + 66), Color = Palette[3], Width = 4f });

            Op pen = new Op { Kind = ToolKind.Pen, Color = Palette[5], Width = 4f };
            for (int i = 0; i < 40; i++)
                pen.Points.Add(new PointF(area.Left + w + 40 + i * 4, area.Top + h + 90 + (float)Math.Sin(i / 4.0) * 22));
            ops.Add(pen);

            Op mosaic = new Op { Kind = ToolKind.Mosaic, Rect = new Rectangle(area.Left + w + 60, area.Top + h + 40, Math.Max(20, w / 2), Math.Max(20, h / 2)), Width = 4f };
            Bitmap patch = Mosaic(full, mosaic.Rect, 1f);
            if (patch != null) { mosaic.Snapshot = patch; ops.Add(mosaic); }

            Op text = new Op { Kind = ToolKind.Text, Color = Color.White, Width = 5f };
            text.Text = "示例文字 Sample";
            text.Rect = new RectangleF(area.Left + w + 30, area.Top + h + 150, 200, 30);
            ops.Add(text);
        }

        static Bitmap Mosaic(Bitmap source, RectangleF area, float scale)
        {
            Rectangle rect = Rectangle.Round(area);
            rect.Intersect(new Rectangle(0, 0, source.Width, source.Height));
            if (rect.Width < 2 || rect.Height < 2) return null;
            int block = Math.Max(6, (int)(9 * scale));
            using (Bitmap snap = source.Clone(rect, PixelFormat.Format32bppArgb))
            {
                int w = Math.Max(1, rect.Width / block);
                int h = Math.Max(1, rect.Height / block);
                using (Bitmap small = new Bitmap(w, h))
                {
                    using (Graphics sg = Graphics.FromImage(small))
                    {
                        sg.InterpolationMode = InterpolationMode.HighQualityBilinear;
                        sg.DrawImage(snap, 0, 0, w, h);
                    }
                    return new Bitmap(small, rect.Width, rect.Height);
                }
            }
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (input != null) return;
            if (e.KeyCode == Keys.Escape)
            {
                if (selected != null) { selected = null; }
                else if (tool != ToolKind.None) { tool = ToolKind.None; Recalculate(); }
                else if (hasSel) { hasSel = false; Recalculate(); }
                else { Finish("cancel"); }
                Invalidate();
                e.SuppressKeyPress = true;
            }
            else if (e.Control && e.KeyCode == Keys.Z)
            {
                if (e.Shift) Redo(); else Undo();
                e.SuppressKeyPress = true;
            }
            else if (e.Control && e.KeyCode == Keys.Y)
            {
                Redo();
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Delete || e.KeyCode == Keys.Back)
            {
                if (selected != null)
                {
                    Op removed = selected;
                    ops.Remove(removed);
                    redo.Add(removed);
                    if (redo.Count > 64) redo.RemoveAt(0);
                    selected = null;
                    Recalculate();
                    Invalidate();
                }
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Enter)
            {
                if (hasSel) { Finish("insert"); e.SuppressKeyPress = true; }
            }
            else if (e.Control && e.KeyCode == Keys.A)
            {
                sel = new Rectangle(0, 0, full.Width, full.Height);
                hasSel = true;
                Recalculate();
                Invalidate();
                e.SuppressKeyPress = true;
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (tick != null) tick.Dispose();
                foreach (Op op in ops) { if (op.Snapshot != null) op.Snapshot.Dispose(); }
                foreach (Op op in redo) { if (op.Snapshot != null) op.Snapshot.Dispose(); }
            }
            base.Dispose(disposing);
        }

        /* ---------------------------------------------------------------- *
         * Entry point
         * ---------------------------------------------------------------- */
        public static Result Run(string fullPath, int x, int y, int w, int h, string outPath, bool selfTest)
        {
            try { Application.EnableVisualStyles(); }
            catch { }
            using (Bitmap full = new Bitmap(fullPath))
            {
                using (EditorForm form = new EditorForm(full, new Rectangle(x, y, w, h), outPath, selfTest))
                {
                    form.ShowDialog();
                    return form.result ?? new Result { Action = "cancel", Width = 0, Height = 0 };
                }
            }
        }
    }

    /// <summary>Entry point used by the capture helper.</summary>
    public static class Editor
    {
        public static Result Run(string fullPath, int x, int y, int w, int h, string outPath, bool selfTest)
        {
            return EditorForm.Run(fullPath, x, y, w, h, outPath, selfTest);
        }
    }
}
