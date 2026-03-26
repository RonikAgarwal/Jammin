from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


OUTPUT_PATH = Path("/Users/ronikagarwal/Desktop/jammin/output/pdf/jammin-app-summary.pdf")
PAGE_WIDTH, PAGE_HEIGHT = letter
MARGIN = 36
GUTTER = 12
CARD_RADIUS = 14
CARD_PADDING = 14


def make_styles() -> dict[str, ParagraphStyle]:
    sample = getSampleStyleSheet()
    return {
        "kicker": ParagraphStyle(
            "Kicker",
            parent=sample["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.2,
            leading=9.5,
            textColor=colors.HexColor("#4F6B8A"),
        ),
        "title": ParagraphStyle(
            "Title",
            parent=sample["Title"],
            fontName="Helvetica-Bold",
            fontSize=23,
            leading=26,
            textColor=colors.HexColor("#10223A"),
        ),
        "subtitle": ParagraphStyle(
            "Subtitle",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=8.6,
            leading=11,
            textColor=colors.HexColor("#4E6174"),
        ),
        "card_title": ParagraphStyle(
            "CardTitle",
            parent=sample["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=14,
            textColor=colors.HexColor("#123256"),
        ),
        "mini_heading": ParagraphStyle(
            "MiniHeading",
            parent=sample["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=8.4,
            leading=10.4,
            textColor=colors.HexColor("#2F6FED"),
            spaceAfter=2,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=8.6,
            leading=11.2,
            textColor=colors.HexColor("#1D2B3A"),
        ),
        "bullet": ParagraphStyle(
            "Bullet",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=8.3,
            leading=10.2,
            textColor=colors.HexColor("#1D2B3A"),
            leftIndent=11,
            firstLineIndent=-7,
            bulletIndent=0,
        ),
        "steps": ParagraphStyle(
            "Steps",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=8.5,
            leading=10.6,
            textColor=colors.HexColor("#1D2B3A"),
            leftIndent=12,
            firstLineIndent=-10,
            bulletIndent=0,
        ),
        "note": ParagraphStyle(
            "Note",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=7.7,
            leading=9.4,
            textColor=colors.HexColor("#5A6B7B"),
        ),
    }


def para(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def draw_paragraphs(
    canv: canvas.Canvas,
    x: float,
    y_top: float,
    width: float,
    items: list[Paragraph],
    gap: float = 4,
) -> float:
    cursor = y_top
    for item in items:
        _, height = item.wrap(width, PAGE_HEIGHT)
        item.drawOn(canv, x, cursor - height)
        cursor -= height + gap
    return cursor


def draw_card(
    canv: canvas.Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    title: str,
    accent: str,
    fill: str,
    body_items: list[Paragraph],
) -> None:
    canv.saveState()
    canv.setFillColor(colors.HexColor(fill))
    canv.roundRect(x, y, width, height, CARD_RADIUS, fill=1, stroke=0)
    canv.setFillColor(colors.HexColor(accent))
    canv.roundRect(x, y + height - 6, width, 6, CARD_RADIUS, fill=1, stroke=0)

    title_paragraph = para(title, STYLES["card_title"])
    text_width = width - (CARD_PADDING * 2)
    _, title_height = title_paragraph.wrap(text_width, height)
    title_paragraph.drawOn(canv, x + CARD_PADDING, y + height - CARD_PADDING - title_height)

    draw_paragraphs(
        canv,
        x + CARD_PADDING,
        y + height - CARD_PADDING - title_height - 8,
        text_width,
        body_items,
        gap=4,
    )
    canv.restoreState()


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    canv = canvas.Canvas(str(OUTPUT_PATH), pagesize=letter)
    canv.setTitle("Jammin App Summary")
    canv.setAuthor("OpenAI Codex")
    canv.setSubject("One-page repo-based summary of the Jammin app")

    canv.setFillColor(colors.HexColor("#F4F8FC"))
    canv.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)

    header_items = [
        para("Repo Summary", STYLES["kicker"]),
        para("Jammin", STYLES["title"]),
        para(
            "Source basis: README.md, package.json, server/*.js, public/*.js, public/index.html, and .env.example. "
            "Summary uses repo evidence only.",
            STYLES["subtitle"],
        ),
    ]
    draw_paragraphs(canv, MARGIN, PAGE_HEIGHT - MARGIN + 6, PAGE_WIDTH - (MARGIN * 2), header_items, gap=3)

    content_top = PAGE_HEIGHT - 112
    content_width = PAGE_WIDTH - (MARGIN * 2)
    column_width = (content_width - GUTTER) / 2

    what_it_is = [
        para(
            "Jammin is a browser-based shared listening app for synced YouTube playback in a room. "
            "The repo combines a static frontend, a Node/Express server, WebSockets, and the YouTube IFrame player "
            "to keep queue, chat, participants, and playback state aligned across clients.",
            STYLES["body"],
        ),
    ]

    left_column = [
        para("Who It's For", STYLES["mini_heading"]),
        para(
            "Primary persona: small groups of listeners who want one room code and one active controller while everyone else follows the same track live.",
            STYLES["body"],
        ),
        para("What It Does", STYLES["mini_heading"]),
        Paragraph(
            "Create or join 6-character rooms with participant presence tracking.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "Play shared YouTube audio/video through an embedded IFrame player.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "Search YouTube in-app and queue results or Play Next when the API key is configured.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "Let the controller play, pause, seek, skip, reorder/remove queue items, and pass controls.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "Show room chat, notifications, and participant states such as in-sync, behind, away, or unstable.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "Recover from lag or ads with Go Live/Reconnect prompts and server-driven resync messages.",
            STYLES["bullet"],
            bulletText="-",
        ),
    ]

    right_column = [
        Paragraph(
            "<b>Client:</b> <font face='Courier'>index.html</font> loads <font face='Courier'>app.js</font> plus focused UI modules "
            "for player, queue, participants, chat, sync feedback, and notifications.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "<b>Server:</b> <font face='Courier'>server/server.js</font> serves <font face='Courier'>public/</font>, exposes "
            "<font face='Courier'>/api/youtube/search</font>, and handles WebSocket room messages.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "<b>Services:</b> <font face='Courier'>session.js</font> manages in-memory rooms/chat; "
            "<font face='Courier'>queue.js</font> manages current/upcoming/history; "
            "<font face='Courier'>sync.js</font> coordinates playback events; "
            "<font face='Courier'>lag.js</font> interprets client time reports.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "<b>External APIs:</b> the browser uses the YouTube IFrame API; the server uses YouTube Data API search and falls back to YouTube oEmbed/video metadata checks.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "<b>Data flow:</b> UI actions send HTTP or JSON WebSocket messages to the server; server modules update process-memory state and broadcast events back; clients update DOM plus player state.",
            STYLES["bullet"],
            bulletText="-",
        ),
        Paragraph(
            "<b>Storage:</b> session, queue, playback, and chat data live in memory. Persistent storage is Not found in repo.",
            STYLES["bullet"],
            bulletText="-",
        ),
    ]

    how_to_run = [
        Paragraph("Install dependencies with <font face='Courier'>npm install</font>.", STYLES["steps"], bulletText="1."),
        Paragraph(
            "Optional: copy <font face='Courier'>.env.example</font> to <font face='Courier'>.env</font> and set "
            "<font face='Courier'>YOUTUBE_API_KEY</font> to enable the in-app search endpoint.",
            STYLES["steps"],
            bulletText="2.",
        ),
        Paragraph(
            "Start the server with <font face='Courier'>npm run dev</font> (same command path as <font face='Courier'>npm start</font>).",
            STYLES["steps"],
            bulletText="3.",
        ),
        Paragraph(
            "Open <font face='Courier'>http://localhost:3000</font>, enter a name, then create a room or join with a code.",
            STYLES["steps"],
            bulletText="4.",
        ),
        para(
            "Not found in repo: required Node version, automated tests, production deployment steps, and authentication/user accounts.",
            STYLES["note"],
        ),
    ]

    draw_card(
        canv,
        MARGIN,
        content_top - 88,
        content_width,
        88,
        "What It Is",
        "#2F6FED",
        "#FFFFFF",
        what_it_is,
    )

    middle_bottom = content_top - 88 - 12 - 260
    draw_card(
        canv,
        MARGIN,
        middle_bottom,
        column_width,
        260,
        "Audience + Features",
        "#27A17A",
        "#F8FCFB",
        left_column,
    )
    draw_card(
        canv,
        MARGIN + column_width + GUTTER,
        middle_bottom,
        column_width,
        260,
        "How It Works",
        "#F08A24",
        "#FFF9F2",
        right_column,
    )

    draw_card(
        canv,
        MARGIN,
        50,
        content_width,
        150,
        "How To Run",
        "#7457D9",
        "#FBFAFF",
        how_to_run,
    )

    canv.showPage()
    canv.save()


STYLES = make_styles()


if __name__ == "__main__":
    main()
