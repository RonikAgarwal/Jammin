Jammin
A small project to listen to YouTube music together in sync.
Create a session, share the code, and everyone in the room listens to the same track — kinda like passing the aux, but online.

Status
Still building this.
Basic stuff works, but a lot is in progress.

What it does (so far)
create/join sessions
play YouTube videos together
basic sync using sockets

What I’m trying to build
smooth sync (no annoying jumps)
queue system (like shared playlist)
handle ads + lag properly
clean lofi-style UI
spotify playlist import with match review

Run locally
git clone https://github.com/RonikAgarwal/Jammin.git
cd Jammin
npm install
npm start

Create a `.env` with:
- `YOUTUBE_API_KEY`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

Idea
Just wanted something where:
“we can listen to the same song at the same time… without it feeling broken”
