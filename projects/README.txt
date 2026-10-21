PROJECTS - for the site editor
==============================

Every folder in here is one project on the map.

ADD a project      copy the student's folder in here, then double-click build.bat
REMOVE a project   delete the folder (or rename it to start with _ to hide it),
                   then double-click build.bat
CHANGE a project   edit its files, then double-click build.bat

build.bat writes js/projects-data.js - the website only reads that file,
so changes show up after running it (and reloading the page).
It also re-packs _TEMPLATE into Democracy-and-Space_project-template.zip,
so the zip for students always matches the template.

Folders starting with _ are ignored: _TEMPLATE is the example to send to
students (see _TEMPLATE/HOW-TO.txt).


FILE NAMES - the ending sets the function
    <name>_hero.png / .mp4      represents the project on the landing page:
                                an image (.png .jpg .webp .gif .svg .avif)
                                or a video (.mp4 .webm) - if both exist,
                                the video is used
    <name>_1.jpg, _2, _3 ...    images on the project page, in this order
                                (<name>_4.mp4 puts a video in that place)
    <name>_info.txt             title, location, author, year, text, captions
    <name>_background.mp4       optional page background video
                                (without it, a _hero video is used)
Files that don't follow this are skipped - build.bat lists them.


MAP POSITION
New projects are placed automatically in a free spot, in the order the
folders were added. Removing or adding projects can move the automatic
ones around - to pin a project, add its grid position to its _info.txt:

    POSITION: 4, -2

(hover the map: the col, row of any spot is shown bottom-left)


OPTIONAL SETTINGS in _info.txt (for fine-tuning, students don't need these)

    POSITION: 4, -2       fixed grid position (col, row)
    MAP WIDTH: 300        width of the hero drawing / video on the map, in px
    ANCHOR: 0.5, 1        point of the hero drawing that sits on the grid corner,
                          as fractions of its width and height
                          (0.5, 1 = bottom center - right for tightly cropped drawings)
    VIDEO FOCUS: 0.5      which part of the hero video the map crop shows
                          (0 = left edge ... 1 = right edge)
    INVERT: no            hero images are shown inverted (made for white
                          drawings) - "no" keeps the real colors, e.g. for photos
