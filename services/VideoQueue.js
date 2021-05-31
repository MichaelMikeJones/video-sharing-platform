const Ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const Queue = require('bull');
const Path = require('path');
const getFilenameAndExt = require('../utilities/splitFilenameAndExt');

const { 
    setVideoToProcessing,
    setVideoToWaiting,
    videoTranscodingCompleted,
    setVideoToFailed
} = require('../controller/video');


// clearing the redis db in starting ----------------------------
const videoQueue = new Queue('video transcoding queue', 'redis://127.0.0.1:6379');
videoQueue.clean(0, 'delayed');
videoQueue.clean(0, 'wait');
videoQueue.clean(0, 'active');
videoQueue.clean(0, 'completed');
videoQueue.clean(0, 'failed');

let multi = videoQueue.multi();
multi.del(videoQueue.toKey('repeat'));
multi.exec();
// ---------------------------------------------------------------

// setting binaries
Ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
Ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);



const videoFolder = Path.join(__dirname, '../storage/videos');

function transcodeVideo(job) {
    const videoFilename = job.data.videoFilename;
    const dedicatedDir = job.data.dedicatedDir;
    const dedicatedDirPath = Path.join(videoFolder, dedicatedDir);
    const [fileName, ext] = getFilenameAndExt(videoFilename);

    return new Promise((resolve, reject) => {

        const options = [
            `-loglevel error`,
            `-y`,
            `-i '../${videoFilename}'`,
            `-filter_complex "[0:v]fps=fps=30,split=3[v1][v2][v3];[v1]scale=width=-2:height=1080[1080p];[v2]scale=width=-2:height=720[720p];[v3]scale=width=-2:height=360[360p]"`,
            `-crf:v 23`,
            `-profile:v high`,
            `-pix_fmt:v`, `yuv420p`,
            `-rc-lookahead:v 60`,
            `-force_key_frames:v expr:'gte(t,n_forced*2.000)'`,
            `-b-pyramid:v "strict"`,
            `-preset:v "medium"`,
            `-map [1080p]`, 
            `-maxrate:v:0 2000000`, 
            `-bufsize:v:0 2*2000000`, 
            `-level:v:0 4.0`,
            `-map [720p]`,
            `-maxrate:v:1 1200000`,
            `-bufsize:v:1 2*1000000`,
            `-level:v:1 3.1`,
            `-map [360p]`,
            `-maxrate:v:2 700000`,
            `-bufsize:v:2 2*500000`,
            `-level:v:2 3.1`,
            `-map 0:a:0`,
            `-b:a:0 192000`,
            `-map 0:a:0`,
            `-b:a:1 128000`,
            `-map 0:a:0`,
            `-b:a:2 96000`,
            `-f hls`,
            `-hls_flags +independent_segments+program_date_time+single_file`,
            `-hls_time 6`,
            `-hls_playlist_type vod`,
            `-hls_segment_type mpegts`,
            `-master_pl_name 'master.m3u8'`,
            `-var_stream_map`, `"v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:360p"`,
            `-hls_segment_filename 'segment_%v.ts' 'manifest_%v.m3u8'`
        ];

        const command = spawn('ffmpeg', options, {
            shell: true,
            cwd: dedicatedDirPath
        });


        command.stdout.on('data', (data) => {
            // console.log(`stdout: ${data}`);
        });

        command.stderr.on('data', (data) => {
            // console.error(`stderr: ${data}`);
            reject(new Error(data));
        });

        command.on('close', (code) => {
            // console.log(`child process closed with code ${code}`);
            resolve();
        });

    });
}

videoQueue.process((job) => {
    return transcodeVideo(job);
});

videoQueue.on('active', async function(job, jobPromise) {
    await setVideoToProcessing(job.id);
});

videoQueue.on('waiting', async function(jobId){
    // A Job is waiting to be processed as soon as a worker is idling.
    await setVideoToWaiting(jobId);
});

videoQueue.on('failed', async function(job, err) {
    await setVideoToFailed(job.id);
    job.remove();
});

videoQueue.on('progress', function(job, progress) {
    // console.log(`PROGRESS: ${progress}`);
});

videoQueue.on('completed', async function(job, result) {
    await videoTranscodingCompleted(job.id);
    job.remove();
});

module.exports = videoQueue;



/*

ffmpeg -i ../20210326_125609.mp4 \
-filter_complex \
"[0:v]fps=fps=30,split=3[v1][v2][v3]; \
[v1]scale=width=-2:height=1080[1080p]; [v2]scale=width=-2:height=720[720p]; [v3]scale=width=-2:height=360[360p]" \
-codec:v libx264 -crf:v 23 -profile:v high -pix_fmt:v yuv420p -rc-lookahead:v 60 -force_key_frames:v expr:'gte(t,n_forced*2.000)' -preset:v "medium" -b-pyramid:v "strict"  \
-map [1080p] -maxrate:v:0 2000000 -bufsize:v:0 2*2000000 -level:v:0 4.0 \
-map [720p] -maxrate:v:1 1200000 -bufsize:v:1 2*1000000 -level:v:1 3.1 \
-map [360p] -maxrate:v:2 700000 -bufsize:v:2 2*500000 -level:v:2 3.1 \
-codec:a libfdk_aac -ac:a 2 \
-map 0:a:0 -b:a:0 192000 \
-map 0:a:0 -b:a:1 128000 \
-map 0:a:0 -b:a:2 96000 \
-f hls \
-hls_flags +independent_segments+program_date_time+single_file \
-hls_time 6 \
-hls_playlist_type vod \
-hls_segment_type mpegts \
-master_pl_name 'master.m3u8' \
-var_stream_map \'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:360p\' \
-hls_segment_filename 'segment_%v_%05d.ts' 'manifest_%v.m3u8'




ffmpeg -i segment_360p.ts -i ../sub1.srt \
-c:v copy \
-c:s webvtt \
-map 0:v \
-map 1:s \
-shortest \
-f hls \
-hls_flags +independent_segments+program_date_time+single_file \
-hls_time 6 \
-hls_playlist_type vod \
-hls_subtitle_path sub_eng.m3u8 \
-hls_segment_type mpegts \
-var_stream_map 'v:0,s:0,name:Spanish,sgroup:subtitle' \
-hls_segment_filename 'redundant_%v.ts' sub_%v.m3u8

*/

