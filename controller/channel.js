const CatchAsync = require('../utilities/CatchAsync');
const Channel = require('../models/Channel');
const filterObject = require('../utilities/filterObject');
const AppError = require('../utilities/AppError');

const ownsChannel = async (user, channelId = undefined, channel) => {
    if (channelId) {
        channel = await Channel.findById(channelId);
    }

    return channel.owner.toString() === user._id.toString();
}

exports.ownsChannel = ownsChannel;

exports.pushVideo = (channelId, videoId) => {
    return Channel.findByIdAndUpdate(
        channelId, 
        { 
            $push: { videos: videoId } 
        }, 
        {
            new: true,
            runValidators: true
        }
    );
}

exports.createChannel = CatchAsync(async (req, res, next) => {
    req.body.owner = req.user._id;
    
    const channel = await Channel.create(
        filterObject(req.body, 
            'name', 'description', 'avatar', 'owner'
        )
    );

    res.status(201).json({
        status: 'success',
        message: 'Channel created successfully',
        data: {
            channel
        }
    });
});

exports.updateChannel = CatchAsync(async (req, res, next) => {
    const channelId = req.params.id;

    const channel = await Channel.findById(channelId);


    if (!(await ownsChannel(req.user, undefined, channel))) {
        return next(new AppError('Only channel owner can update the channel', 401));
    }

    // updating the channel
    channel.set(filterObject(req.body, 'name', 'description', 'avatar'));
    await channel.save();

    res.status(200).json({
        status: 'success',
        message: 'Channel updated successfully',
        data: {
            channel
        }
    })
})

exports.getChannel = CatchAsync(async(req, res, next) => {
    const channelId = req.params.id;

    const channel = await Channel.findById(channelId).select({ subscribers: 0, __v: 0 });

    res.status(200).json({
        status: 'success',
        data: {
            channel
        }
    })
});

exports.pushSubscriber = async (channelId, userId) => {
    const channel = await Channel.findById(channelId);
    channel.pushSubscriber(userId);
    await channel.save();
}

exports.removeSubscriber = async (channelId, userId) => {
    const channel = await Channel.findById(channelId)
    channel.removeSubscriber(userId);
    await channel.save();
}


exports.deleteChannel = CatchAsync(async (req, res, next) => {
    const channelId = req.params.id;

    const channel = await Channel.findById(channelId);

    if (!channel) {
        return next(new AppError('Channel not found', 404));
    }

    if (!(await ownsChannel(req.user, undefined, channel))) {
        return next(new AppError('You don\'t own this channel', 401));
    }

    if (channel.isDeleted) {
        return next(new AppError('Channel is already deleted', 400));
    }

    // requiring video controller here to avoid cyrcular import
    const { deleteManyVideos } = require('./video');

    await deleteManyVideos(channel.videos);

    channel.isDeleted = true;
    await channel.save();

    res.status(204).json({
        status: 'success',
        message: 'Channel and its videos deleted successfully'
    });
})
