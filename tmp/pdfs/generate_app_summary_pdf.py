from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


OUTPUT_PATH = Path("/Users/ronikagarwal/Desktop/jammin/output/pdf/jammin-app-summary.pdf")


def bullet(text: str) -> str:
    return f'<bullet>&bull;</bullet>{text}'


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    doc = SimpleDocTemplate(
        str(OUTPUT_PATH),
        pagesize=letter,
        leftMargin=0.55 * inch,
        rightMargin=0.55 * inch,
        topMargin=0.5 * inch,
        bottomMargin=0.45 * inch,
    )

    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#10223A"),
        spaceAfter=6,
    )
    subtitle = ParagraphStyle(
        "Subtitle",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9,
        leading=11,
        textColor=colors.HexColor("#506070"),
        spaceAfter=10,
    )
    heading = ParagraphStyle(
        "Heading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=13,
        textColor=colors.HexColor("#0F5F8C"),
        spaceBefore=6,
        spaceAfter=3,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8.4,
        leading=10.2,
        textColor=colors.HexColor("#1B2838"),
        spaceAfter=2,
    )
    bullet_style = ParagraphStyle(
        "Bullet",
        parent=body,
        leftIndent=11,
        firstLineIndent=-7,
        bulletIndent=0,
        spaceAfter=1.2,
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=7.6,
        leading=9.1,
        textColor=colors.HexColor("#52606D"),
        spaceAfter=0,
    )

    story = [
        Paragraph("Jammin App Summary", title),
        Paragraph(
            "Source basis: package.json, server/*.js, public/*.js, and public/index.html. "
            "This summary uses repo evidence only.",
            subtitle,
        ),
        Paragraph("What It Is", heading),
        Paragraph(
            "Jammin is a real-time synchronized YouTube listening web app with shared sessions, "
            "a live queue, and coordinated playback across connected browsers. "
            "The repo describes it as a \"Real-time synchronized YouTube listening platform\" "
            "and serves a browser UI backed by an Express and WebSocket server.",
            body,
        ),
        Paragraph("Who It's For", heading),
        Paragraph(
            "Primary persona: people who want to listen to YouTube music together in a shared live session, "
            "with one host controlling playback and others joining by session code.",
            body,
        ),
        Paragraph("What It Does", heading),
        Paragraph(
            bullet("Creates and joins 6-character listening sessions with participant tracking."),
            bullet_style,
        ),
        Paragraph(
            bullet("Queues YouTube tracks from pasted links and resolves video titles plus thumbnails."),
            bullet_style,
        ),
        Paragraph(
            bullet("Lets the host add tracks, play next, play selected, remove items, and reorder the queue."),
            bullet_style,
        ),
        Paragraph(
            bullet("Coordinates cueing and synchronized playback over WebSockets with readiness checks."),
            bullet_style,
        ),
        Paragraph(
            bullet("Keeps clients aligned with play, pause, resume, seek, and go-live resync messages."),
            bullet_style,
        ),
        Paragraph(
            bullet("Detects lag and unstable connections from periodic time reports and surfaces recovery prompts."),
            bullet_style,
        ),
        Paragraph(
            bullet("Handles ad interruptions and auto-syncs participants back to the live position after ads."),
            bullet_style,
        ),
        Paragraph("How It Works", heading),
        Paragraph(
            bullet(
                "<b>Frontend:</b> static files in <font face='Courier'>public/</font> render the landing page, "
                "session UI, queue, participant list, notifications, sync bar, and a YouTube IFrame player wrapper."
            ),
            bullet_style,
        ),
        Paragraph(
            bullet(
                "<b>Server:</b> <font face='Courier'>server/server.js</font> runs Express for static hosting and a "
                "WebSocket server for all real-time session messages."
            ),
            bullet_style,
        ),
        Paragraph(
            bullet(
                "<b>State and services:</b> <font face='Courier'>session.js</font> stores in-memory rooms and host/participant data; "
                "<font face='Courier'>queue.js</font> manages queue mutations; <font face='Courier'>sync.js</font> coordinates preload, "
                "majority-ready play, state sync, and track advance; <font face='Courier'>lag.js</font> evaluates client time reports."
            ),
            bullet_style,
        ),
        Paragraph(
            bullet(
                "<b>Data flow:</b> browser actions send JSON WebSocket messages to the server; server modules update in-memory session state "
                "and broadcast session, queue, and playback events back to clients; clients apply those events to UI and the YouTube player."
            ),
            bullet_style,
        ),
        Paragraph("How To Run", heading),
        Paragraph(
            bullet("Install dependencies: <font face='Courier'>npm install</font>"),
            bullet_style,
        ),
        Paragraph(
            bullet("Start the app: <font face='Courier'>npm start</font>"),
            bullet_style,
        ),
        Paragraph(
            bullet("Open <font face='Courier'>http://localhost:3000</font> unless <font face='Courier'>PORT</font> is set."),
            bullet_style,
        ),
        Paragraph(
            bullet("Enter a name, create a session or join with a code, then paste a YouTube link."),
            bullet_style,
        ),
        Spacer(1, 6),
        Paragraph(
            "Not found in repo: production deployment instructions, automated tests, database/persistent storage, authentication, and required Node version.",
            small,
        ),
    ]

    doc.build(story)


if __name__ == "__main__":
    main()
