const Path = require('path');
const CatchAsync = require('../utilities/CatchAsync');
const AppError = require('../utilities/AppError');
const filterObject = require('../utilities/filterObject');
const { ownsChannel, pushVideo } = require('./channel');
const Video = require('../models/Video');
const getVideoDetails = require('../utilities/getVideoDetails');
const generateThumbnail = require('../services/createThumbnail');
const mime = require('mime-types');
const { pipeline } = require('stream');
const { createReadStream } = require('fs');

const folderPath = process.env.VIDEO_FOLDER;

const getVideoDetailsInDesiredFormat = async (videoFilePath) => {
    const details = await getVideoDetails(videoFilePath);

    const frameRate = parseFloat(eval(details.streams[0].avg_frame_rate).toFixed(2));

    return {
        filename: Path.basename(videoFilePath),
        fileSize: details.format.size,
        frameRate,
        resolution: `${details.streams[0].width}x${details.streams[0].height}`,
        videoBitrate: details.streams[0].bit_rate,
        videoCodec: details.streams[0].codec_name,
        audioBitrate: details.streams[1].bit_rate,
        audioCodec: details.streams[1].codec_name,
        audioChannels: details.streams[1].channels,
        duration: details.format.duration,
        overallBitrate: details.format.bit_rate
    }
}

const ownsVideo = async (user, videoId, video) => {
    if (videoId) {
        video = await Video.findById(videoId);
    }

    return ownsChannel(user, video.creator);
}

exports.getVideo = CatchAsync(async (req, res, next) => {
    const videoId = req.params.id;

    const video = await Video.findById(videoId);

    if (!video || video.isDeleted) {
        return next(new AppError('Video not found', 404));
    }

    if (!video.isPublished && !(await ownsChannel(req.user, video.creator))) {
        return next(new AppError('Video is not published yet', 403));
    }

    res.status(200).json({
        status: 'success',
        data: {
            video
        }
    })
})

exports.streamVideo = CatchAsync(async (req, res, next) => {
    const videoId = req.params.id;
    const resolution = req.params.resolution;
    const range = req.headers.range

    const video = await Video.findById(videoId);

    if (!video || video.isDeleted) {
        return next(new AppError('Video not found', 404));
    }

    if (!video.isPublished) {
        return next(new AppError('Video is not published yet', 403));
    }

    if (!video.availableResolutions.includes(resolution)) {
        return next(new AppError(`${resolution} is not available. Available resolutions are ${video.availableResolutions.join(', ')}`, 400));
    }


    const key = `video${resolution}p`;

    const path = `${folderPath}/${video[key].filename}`;
    const fileSize = video[key].fileSize;
    const mimetype = mime.lookup(video[key].filename);

    if (range) {

        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] 
        ? parseInt(parts[1], 10)
        : fileSize-1;

        const chunksize = (end-start)+1;
        const file = createReadStream(path, {start, end});
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mimetype,
        }

        res.writeHead(206, head);
        pipeline(file, res, (err) => {
            // console.log(err);
        });

    } else {

        const head = {
            'Content-Length': fileSize,
            'Content-Type': mimetype,
            'Accept-Ranges': 'bytes',
        };

        res.writeHead(200, head);
        pipeline(createReadStream(path), res, (err) => {
            // console.log(err);
        });

    }
})

exports.createVideo = CatchAsync(async (req, res, next) => {
    if (!req.file) {
        return next(new AppError('Video is not provided', 400));
    }

    req.body = filterObject(req.body, 
        'creator', 'language', 'title', 'description');

    if (!(await ownsChannel(req.user, req.body.creator))) {
        return next(new AppError('You don\'n own this channel', 403));
    }

    const videoDetails = await getVideoDetailsInDesiredFormat(req.file.path);
    req.body.orgVideo = videoDetails;
    req.body.duration = videoDetails.duration;

    const { filename: thumbnail } = await generateThumbnail(req.file.path);
    req.body.thumbnail = thumbnail;

    const video = await Video.create(req.body);

    res.status(201).json({
        status: 'success',
        message: 'Video created successfully',
        data: {
            video
        }
    });
});

exports.updateVideo = CatchAsync(async (req, res, next) => {
    const videoId = req.params.id;

    const video = await Video.findById(videoId);

    if (!video || video.isDeleted) {
        return next(new AppError('Video not found', 404));
    }

    if (!(await ownsVideo(req.user, undefined, video))) {
        return next(new AppError('You don\'t own this video', 403));
    }

    req.body = filterObject(req.body, 
        'creator', 'language', 'title', 'description');

    video.set(req.body);

    await video.save();

    res.status(200).json({
        status: 'success', 
        message: 'Video updated successfully',
        data: {
            video
        }
    })
})

exports.publish = CatchAsync(async (req, res, next) => {
    const videoId = req.params.id;

    const video = await Video.findById(videoId);

    if (!video || video.isDeleted) {
        return next(new AppError('Video not found', 404));
    }

    if (!(ownsVideo(req.user, undefined, video))) {
        return next(new AppError('You don\'t own this video', 403));
    }

    if (video.status !== 'Ready to publish') {
        return next(new AppError(`Video status should be Ready to publish. but the current status is ${video.status}`, 400));
    }

    video.isPublished = true;
    video.status = 'Published';
    await video.save();

    res.status(200).json({
        status: 'success', 
        message: 'Video published successfully'
    });
});

exports.startTranscoding = CatchAsync(async (req, res, next) => {
    const videoId = req.params.id;

    const video = await Video.findById(videoId);

    if (!video || video.isDeleted) {
        return next(new AppError('Video not found', 404));
    }

    if (!(ownsVideo(req.user, undefined, video))) {
        return next(new AppError('You don\'t own this video', 403));
    }

    if (video.status !== 'Ready for processing') {
        return next(new AppError(`Video status should be Ready for processing. but the current status is ${video.status}`, 400));
    }

    const VideoQueue = require('../services/VideoQueue');

    VideoQueue.add(
        {
            videoFilePath: `${folderPath}/${video.orgVideo.filename}`,
            resolution: video.orgVideo.resolution
        }, 
        { 
            jobId: video._id 
        }
    );

    res.status(202).json({
        status: 'success',
        message: 'Video has been added to transcoding queue'
    });
})

exports.deleteVideo = CatchAsync(async (req, res, next) => {
    const videoId = req.params.id;

    const video = await Video.findById(videoId);

    if (!video || video.isDeleted) {
        return next(new AppError('Video not found', 404));
    }

    if (!(ownsVideo(req.user, undefined, video))) {
        return next(new AppError('You don\'t own this video', 403));
    }

    await video.unlinkVideos();
    video.isDeleted = true;
    video.status = 'Deleted';
    video.isPublished = false;
    await video.save();

    res.status(204).json({
        status: 'success',
        message: 'Video deleted successfully'
    });
});

exports.setVideoToProcessing = (videoId) => {
    return Video.findByIdAndUpdate(
        videoId, 
        { 
            status: 'Processing' 
        }, 
        { 
            new: true 
        }
    );
}

exports.setVideoToWaiting = (videoId) => {
    return Video.findByIdAndUpdate(
        videoId, 
        { 
            status: 'Waiting in queue' 
        }, 
        { 
            new: true 
        }
    );
}

exports.videoTranscodingCompleted = async (videoId, result) => {
    const video = await Video.findById(videoId);

    for (const resolution of Object.keys(result)) {
        const key = `video${resolution}p`;
        const videoPath = result[resolution];
        video[key] = await getVideoDetailsInDesiredFormat(videoPath);
    }

    await video.unlinkOrgVideo();

    video.status = 'Ready to publish';
    video.availableResolutions = Object.keys(result);

    await video.save();
}

exports.setVideoToFailed = (videoId) => {
    return Video.findByIdAndUpdate(
        videoId, 
        { 
            status: 'Failed in processing' 
        }, 
        { 
            new: true 
        }
    );
}
