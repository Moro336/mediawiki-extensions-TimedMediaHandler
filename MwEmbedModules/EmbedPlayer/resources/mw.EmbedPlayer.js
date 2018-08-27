/**
* embedPlayer is the base class for html5 video tag javascript abstraction library
* embedPlayer include a few subclasses:
*
* mediaPlayer Media player embed system ie: java, vlc or native.
* mediaElement Represents source media elements
* mw.PlayerControlBuilder Handles skinning of the player controls
*/
( function ( mw, $ ) {
	'use strict';

	var config = mw.config.get( 'wgTimedMediaHandler' );

	/**
	 * Merge in the default video attributes supported by embedPlayer:
	 */
	mw.mergeTMHConfig( 'EmbedPlayer.Attributes', {
		/*
		 * Base html element attributes:
		 */

		// id: Auto-populated if unset
		id: null,

		// class: Auto-populated if unset
		'class': null,

		// Width: alternate to "style" to set player width
		width: null,

		// Height: alternative to "style" to set player height
		height: null,

		/*
		 * Base html5 video element attributes / states also see:
		 * http://www.whatwg.org/specs/web-apps/current-work/multipage/video.html
		 */

		// Media src URI, can be relative or absolute URI
		src: null,

		// Poster attribute for displaying a place holder image before loading
		// or playing the video
		poster: null,

		// Autoplay if the media should start playing
		autoplay: false,

		// Loop attribute if the media should repeat on complete
		loop: false,

		// If the player controls should be displayed
		controls: true,

		// Video starts "paused"
		paused: true,

		// ReadyState an attribute informs clients of video loading state:
		// see: http://www.whatwg.org/specs/web-apps/current-work/#readystate
		readyState: 0,

		// Loading state of the video element
		networkState: 0,

		// Current playback position
		currentTime: 0,

		// Previous player set time
		// Lets javascript use $('#videoId')[0].currentTime = newTime;
		previousTime: 0,

		// Previous player set volume
		// Lets javascript use $('#videoId')[0].volume = newVolume;
		previousVolume: 1,

		// Initial player volume:
		volume: 0.75,

		// Caches the volume before a mute toggle
		preMuteVolume: 0.75,

		// Media duration: Value is populated via
		// custom data-durationhint attribute or via the media file once its played
		duration: null,

		// A hint to the duration of the media file so that duration
		// can be displayed in the player without loading the media file
		'data-durationhint': null,

		// to disable menu or timedText for a given embed
		'data-disablecontrols': null,

		// Also support direct durationHint attribute ( backwards compatibly )
		// @deprecated please use data-durationhint instead.
		durationHint: null,

		// Mute state
		muted: false,

		/**
		 * Custom attributes for embedPlayer player: (not part of the html5
		 * video spec)
		 */

		// Default video aspect ratio
		videoAspect: '4:3',

		// Start time of the clip
		start: 0,

		// End time of the clip
		end: null,

		// If the player controls should be overlaid
		// ( Global default via config EmbedPlayer.OverlayControls in module
		// loader.js)
		overlaycontrols: true,

		// Attribute to use 'native' controls
		usenativecontrols: false,

		// If the player should include an attribution button:
		attributionbutton: true,

		// A player error object (Includes title and message)
		// * Used to display an error instead of a play button
		// * The full player api available
		playerError: {},

		// A flag to hide the player gui and disable autoplay
		// * Used for empty players or a player where you want to dynamically set sources, then play.
		// * The player API remains active.
		'data-blockPlayerDisplay': null,

		// If serving an ogg_chop segment use this to offset the presentation time
		// ( for some plugins that use ogg page time rather than presentation time )
		startOffset: 0,

		// If the download link should be shown
		downloadLink: true,

		// Content type of the media
		type: null

	} );

	/**
	 * The base source attribute checks also see:
	 * http://dev.w3.org/html5/spec/Overview.html#the-source-element
	 */
	mw.mergeTMHConfig( 'EmbedPlayer.SourceAttributes', [
		// source id
		'id',

		// media url
		'src',

		// Title string for the source asset
		'title',

		// The html5 spec uses label instead of 'title' for naming sources
		'label',

		// boolean if we support temporal url requests on the source media
		'URLTimeEncoding',

		// Media has a startOffset ( used for plugins that
		// display ogg page time rather than presentation time
		'startOffset',

		// Media start time
		'start',

		// Media end time
		'end',

		// If the source is the default source
		'default',

		// Title of the source
		'title',

		// titleKey ( used for api lookups TODO move into mediaWiki specific support
		'titleKey'
	] );

	/**
	 * Base embedPlayer object
	 *
	 * @param {Element} element, the element used for initialization.
	 * @constructor
	 */
	mw.EmbedPlayer = function ( element ) {
		return this.init( element );
	};

	mw.EmbedPlayer.prototype = {

		// The mediaElement object containing all mediaSource objects
		mediaElement: null,

		// Object that describes the supported feature set of the underling plugin /
		// Support list is described in PlayerControlBuilder components
		supports: { },

		// If the player is done loading ( does not guarantee playability )
		// for example if there is an error playerReadyFlag is still set to true once
		// no more loading is to be done
		playerReadyFlag: false,

		// Stores the loading errors
		loadError: false,

		// Thumbnail updating flag ( to avoid rewriting an thumbnail thats already
		// being updated)
		thumbnailUpdatingFlag: false,

		// Stopped state flag
		stopped: true,

		// Local variable to hold CMML meeta data about the current clip
		// for more on CMML see: http://wiki.xiph.org/CMML
		cmmlData: null,

		// Stores the seek time request, Updated by the seek function
		serverSeekTime: 0,

		// If the embedPlayer is current 'seeking'
		seeking: false,

		// Percent of the clip buffered:
		bufferedPercent: 0,

		// Holds the timer interval function
		monitorTimerId: null,

		// Buffer flags
		bufferStartFlag: false,
		bufferEndFlag: false,

		// For supporting media fragments stores the play end time
		pauseTime: null,

		// On done playing
		donePlayingCount: 0,
		// if player events should be Propagated
		_propagateEvents: true,

		// If the onDone interface should be displayed
		onDoneInterfaceFlag: true,

		// if we should check for a loading spinner in the monitor function:
		_checkHideSpinner: false,

		// If pause play controls click controls should be active:
		_playContorls: true,

		// If player should be displayed (in some caused like audio, we don't need the player to be visible
		displayPlayer: true,

		// Widget loaded should only fire once
		widgetLoaded: false,

		/**
		 * embedPlayer
		 *
		 * @constructor
		 *
		 * @param {Element} element DOM element that we are building the player interface for.
		 */
		init: function ( element ) {
			var attr,
				playerAttributes,
				self = this;
			mw.log( 'EmbedPlayer: initEmbedPlayer: ' + $( element ).width() );

			playerAttributes = config[ 'EmbedPlayer.Attributes' ];

			// Store the rewrite element tag type
			this.rewriteElementTagName = element.tagName.toLowerCase();

			this.noPlayerFallbackHTML = $( element ).html();

			// Setup the player Interface from supported attributes:
			for ( attr in playerAttributes ) {
				// We can't use $(element).attr( attr ) because we have to check for boolean attributes:
				if ( element.getAttribute( attr ) !== null ) {
					// boolean attributes
					if ( element.getAttribute( attr ) === '' ) {
						this[ attr ] = true;
					} else {
						this[ attr ] = element.getAttribute( attr );
					}
				} else {
					this[ attr ] = playerAttributes[ attr ];
				}
				// string -> boolean
				if ( this[ attr ] === 'false' ) { this[ attr ] = false; }
				if ( this[ attr ] === 'true' ) { this[ attr ] = true; }
			}

			// Hide "controls" if using native player controls:
			if ( this.useNativePlayerControls() ) {
				self.controls = true;
			}

			// Support custom monitorRate Attribute ( if not use default )
			if ( !this.monitorRate ) {
				this.monitorRate = config[ 'EmbedPlayer.MonitorRate' ];
			}

			// Make sure startOffset is cast as an float:
			if ( this.startOffset && this.startOffset.split( ':' ).length >= 2 ) {
				this.startOffset = parseFloat( mw.npt2seconds( this.startOffset ) );
			}

			// Make sure offset is in float:
			this.startOffset = parseFloat( this.startOffset );

			// Set the source duration
			if ( $( element ).attr( 'duration' ) ) {
				self.duration = $( element ).attr( 'duration' );
			}
			// Add durationHint property form data-durationhint:
			if ( self[ 'data-durationhint' ] ) {
				self.durationHint = self[ 'data-durationhint' ];
			}
			// Update duration from provided durationHint
			if ( self.durationHint && !self.duration ) {
				self.duration = mw.npt2seconds( self.durationHint );
			}

			// Make sure duration is a float:
			this.duration = parseFloat( this.duration );
			mw.log( 'EmbedPlayer::init:' + this.id + ' duration is: ' + this.duration );

			// Add disablecontrols property form data-disablecontrols:
			if ( self[ 'data-disablecontrols' ] ) {
				self.disablecontrols = self[ 'data-disablecontrols' ];
			}

			// Set the playerElementId id
			this.pid = 'pid_' + this.id;

			// Add the mediaElement object with the elements sources:
			this.mediaElement = new mw.MediaElement( element );

			this.bindHelper( 'updateLayout', function () {
				self.updateLayout();
			} );
		},
		/**
		 * Bind helpers to help iOS retain bind context
		 *
		 * Yes, iOS will fail when you run $( embedPlayer ).on()
		 * but "work" when you run .on() from script urls that are different "resources"
		 */
		bindHelper: function ( name, callback ) {
			$( this ).on( name, callback );
			return this;
		},
		unbindHelper: function ( bindName ) {
			if ( bindName ) {
				$( this ).off( bindName );
			}
			return this;
		},
		triggerQueueCallback: function ( name, callback ) {
			$( this ).triggerQueueCallback( name, callback );
		},
		triggerHelper: function ( name, obj ) {
			try {
				$( this ).trigger( name, obj );
			} catch ( e ) {
				// ignore try catch calls
				// mw.log( "EmbedPlayer:: possible error in trgger: " + name + " " + e.toString() );
			}
		},
		/**
		 * Stop events from Propagation and blocks interface updates and trigger events.
		 */
		stopEventPropagation: function () {
			mw.log( 'EmbedPlayer:: stopEventPropagation' );
			this.stopMonitor();
			this._propagateEvents = false;
		},

		/**
		 * Restores event propagation
		 */
		restoreEventPropagation: function () {
			mw.log( 'EmbedPlayer:: restoreEventPropagation' );
			this._propagateEvents = true;
			this.startMonitor();
		},

		/**
		 * Enables the play controls ( for example when an ad is done )
		 */
		enablePlayControls: function () {
			mw.log( 'EmbedPlayer:: enablePlayControls' );
			if ( this.useNativePlayerControls() ) {
				return;
			}
			this._playContorls = true;
			// re-enable hover:
			this.getInterface().find( '.play-btn' )
				.buttonHover()
				.css( 'cursor', 'pointer' );

			this.controlBuilder.enableSeekBar();
			/*
			 * We should pass an array with enabled components, and the controlBuilder will listen
			 * to this event and handle the layout changes. we should not call to this.controlBuilder inside embedPlayer.
			 * [ 'playButton', 'seekBar' ]
			 */
			$( this ).trigger( 'onEnableInterfaceComponents' );
		},

		/**
		 * Disables play controls, for example when an ad is playing back
		 */
		disablePlayControls: function () {
			if ( this.useNativePlayerControls() ) {
				return;
			}
			this._playContorls = false;
			// turn off hover:
			this.getInterface().find( '.play-btn' )
				.off( 'mouseenter mouseleave' )
				.css( 'cursor', 'default' );

			this.controlBuilder.disableSeekBar();
			/**
			 * We should pass an array with disabled components, and the controlBuilder will listen
			 * to this event and handle the layout changes. we should not call to this.controlBuilder inside embedPlayer.
			 * [ 'playButton', 'seekBar' ]
			 */
			$( this ).trigger( 'onDisableInterfaceComponents' );
		},

		/**
		 * For plugin-players to update supported features
		 */
		updateFeatureSupport: function () {
			$( this ).trigger( 'updateFeatureSupportEvent', this.supports );
		},
		/**
		* Apply Intrinsic Aspect ratio of a given image to a poster image layout
		*/
		applyIntrinsicAspect: function () {
			var img, pHeight, pWidth,
				$this = $( this );
			// Check if a image thumbnail is present:
			if ( this.getInterface().find( '.playerPoster' ).length ) {
				img = this.getInterface().find( '.playerPoster' )[ 0 ];
				pHeight = $this.height();
				// Check for intrinsic width and maintain aspect ratio
				if ( img.naturalWidth && img.naturalHeight ) {
					pWidth = Math.floor( img.naturalWidth / img.naturalHeight * pHeight );
					if ( pWidth > $this.width() ) {
						pWidth = $this.width();
						pHeight = Math.floor( img.naturalHeight / img.naturalWidth * pWidth );
					}
					$( img ).css( {
						height: pHeight + 'px',
						width: pWidth + 'px',
						left: ( ( $this.width() - pWidth ) * 0.5 ) + 'px',
						top: ( ( $this.height() - pHeight ) * 0.5 ) + 'px',
						position: 'absolute'
					} );
				}
			}
		},
		/**
		 * Set the width & height from css style attribute, element attribute, or by
		 * default value if no css or attribute is provided set a callback to
		 * resize.
		 *
		 * Updates this.width & this.height
		 *
		 * @param {Element}
		 *      element Source element to grab size from
		 */
		loadPlayerSize: function ( element ) {
			var $relativeParent, aspect, defaultSize;

			// check for direct element attribute:
			this.height = element.height > 0 ? String( element.height ) : $( element ).css( 'height' );
			this.width = element.width > 0 ? String( element.width ) : $( element ).css( 'width' );

			// Special check for chrome 100% with re-mapping to 32px
			// Video embed at 32x32 will have to wait for intrinsic video size later on
			if ( this.height === '32px' || this.height === '32px' ) {
				this.width = '100%';
				this.height = '100%';
			}
			mw.log( 'EmbedPlayer::loadPlayerSize: css size:' + this.width + ' h: ' + this.height );

			// Set to parent size ( resize events will cause player size updates)
			if ( this.height.indexOf( '100%' ) !== -1 || this.width.indexOf( '100%' ) !== -1 ) {
				$relativeParent = $( element ).parents().filter( function () {
					// reduce to only relative position or "body" elements
					return $( this ).is( 'body' ) || $( this ).css( 'position' ) === 'relative';
				} ).slice( 0, 1 ); // grab only the "first"
				this.width = $relativeParent.width();
				this.height = $relativeParent.height();
			}
			// Make sure height and width are a number
			this.height = parseInt( this.height );
			this.width = parseInt( this.width );

			// Set via attribute if CSS is zero or NaN and we have an attribute value:
			this.height = ( this.height === 0 || isNaN( this.height ) &&
					$( element ).attr( 'height' ) ) ?
				parseInt( $( element ).attr( 'height' ) ) : this.height;
			this.width = ( this.width === 0 || isNaN( this.width ) &&
					$( element ).attr( 'width' ) ) ?
				parseInt( $( element ).attr( 'width' ) ) : this.width;

			// Special case for audio

			// Firefox sets audio height to "0px" while webkit uses 32px .. force zero:
			if ( this.isAudio() && this.height === '32' ) {
				this.height = 20;
			}

			// Use default aspect ration to get height or width ( if rewriting a non-audio player )
			if ( this.isAudio() && this.videoAspect ) {
				aspect = this.videoAspect.split( ':' );
				if ( this.height && !this.width ) {
					this.width = parseInt( this.height * ( aspect[ 0 ] / aspect[ 1 ] ) );
				}
				if ( this.width && !this.height ) {
					this.height = parseInt( this.width * ( aspect[ 1 ] / aspect[ 0 ] ) );
				}
			}

			// On load sometimes attr is temporally -1 as we don't have video metadata yet.
			// or in IE we get NaN for width height
			//
			// NOTE: browsers that do support height width should set "waitForMeta" flag in addElement
			if ( ( isNaN( this.height ) || isNaN( this.width ) ) ||
				( this.height === -1 || this.width === -1 ) ||
					// Check for firefox defaults
					// Note: ideally firefox would not do random guesses at css
					// values
					( ( this.height === 150 || this.height === 64 ) && this.width === 300 )
			) {
				defaultSize = config[ 'EmbedPlayer.DefaultSize' ].split( 'x' );
				if ( isNaN( this.width ) ) {
					this.width = defaultSize[ 0 ];
				}

				// Special height default for audio tag ( if not set )
				if ( this.isAudio() ) {
					this.height = 20;
				} else {
					this.height = defaultSize[ 1 ];
				}
			}
		},

		/**
		 * Get the player pixel width not including controls
		 *
		 * @return {Number} pixel height of the video
		 */
		getPlayerWidth: function () {
			var profile = $.client.profile();

			if ( profile.name === 'firefox' && profile.versionNumber < 2 ) {
				return ( $( this ).parent().parent().width() );
			}
			return $( this ).width();
		},

		/**
		 * Get the player pixel height not including controls
		 *
		 * @return {Number} pixel height of the video
		 */
		getPlayerHeight: function () {
			return $( this ).height();
		},

		/**
		 * Check player for sources. If we need to get media sources form an
		 * external file that request is issued here
		 */
		checkPlayerSources: function () {
			var self = this;
			mw.log( 'EmbedPlayer::checkPlayerSources: ' + this.id );
			// Allow plugins to listen to a preCheckPlayerSources ( for registering the source loading point )
			$( self ).trigger( 'preCheckPlayerSources' );

			// Allow plugins to block on sources lookup ( cases where we just have an api key for example )
			$( self ).triggerQueueCallback( 'checkPlayerSourcesEvent', function () {
				self.setupSourcePlayer();
			} );
		},

		/**
		 * Get text tracks from the mediaElement
		 */
		getTextTracks: function () {
			if ( !this.mediaElement ) {
				return [];
			}
			return this.mediaElement.getTextTracks();
		},
		/**
		 * Empty the player sources
		 */
		emptySources: function () {
			if ( this.mediaElement ) {
				this.mediaElement.sources = [];
				this.mediaElement.selectedSource = null;
			}
			// setup pointer to old source:
			this.prevPlayer = this.selectedPlayer;
			// don't null out the selected player on empty sources
			// this.selectedPlayer =null;
		},

		/**
		 * Switch and play a video source
		 *
		 * Checks if the target source is the same playback mode and does player switch if needed.
		 * and calls playerSwitchSource
		 */
		switchPlaySource: function ( source, switchCallback, doneCallback ) {
			var self = this,
				targetPlayer = mw.EmbedTypes.getMediaPlayers().defaultPlayer( source.mimeType );
			if ( targetPlayer.library !== this.selectedPlayer.library ) {
				this.selectedPlayer = targetPlayer;
				this.updatePlaybackInterface( function () {
					self.playerSwitchSource( source, switchCallback, doneCallback );
				} );
			} else {
				// Call the player switch directly:
				self.playerSwitchSource( source, switchCallback, doneCallback );
			}
		},
		/**
		 * abstract function  player interface must support actual source switch
		 */
		playerSwitchSource: function ( /* source, switchCallback, doneCallback */ ) {
			mw.log( 'Error player interface must support actual source switch' );
		},

		/**
		 * Set up the select source player
		 *
		 * issues autoSelectSource call
		 *
		 * Sets load error if no source is playable
		 */
		setupSourcePlayer: function () {
			var self = this;

			mw.log( 'EmbedPlayer::setupSourcePlayer: ' + this.id + ' sources: ' + this.mediaElement.sources.length );

			// Check for source replace configuration:
			if ( config[ 'EmbedPlayer.ReplaceSources' ] ) {
				this.emptySources();
				$.each( config[ 'EmbedPlayer.ReplaceSources' ], function ( inx, source ) {
					self.mediaElement.tryAddSource( source );
				} );
			}

			// Autoseletct the media source
			this.mediaElement.autoSelectSource();

			// Auto select player based on default order
			if ( this.mediaElement.selectedSource ) {
				this.selectedPlayer = mw.EmbedTypes.getMediaPlayers().defaultPlayer( this.mediaElement.selectedSource.mimeType );
				// Check if we need to switch player rendering libraries:
				if ( this.selectedPlayer && ( !this.prevPlayer || this.prevPlayer.library !== this.selectedPlayer.library ) ) {
					// Inherit the playback system of the selected player:
					this.updatePlaybackInterface();
					return;
				}
			}

			// Check if no player is selected
			if ( !this.selectedPlayer || !this.mediaElement.selectedSource ) {
				this.showPlayerError();
				mw.log( 'EmbedPlayer:: setupSourcePlayer > player ready ( but with errors ) ' );
			} else {
				// Trigger layout ready event
				$( this ).trigger( 'layoutReady' );
				// Show the interface:
				this.getInterface().find( '.control-bar' ).show();
				this.addLargePlayBtn();
			}
			// We still do the playerReady sequence on errors to provide an api
			// and player error events
			this.playerReadyFlag = true;
			// trigger the player ready event;
			$( this ).trigger( 'playerReady' );
			this.triggerWidgetLoaded();
		},

		/**
		 * Updates the player interface
		 *
		 * Loads and inherit methods from the selected player interface.
		 *
		 * @param {Function}
		 *      callback Function to be called once playback-system has been
		 *      inherited
		 */
		updatePlaybackInterface: function ( callback ) {
			var tmpObj, i,
				self = this;
			mw.log( 'EmbedPlayer::updatePlaybackInterface: duration is: ' + this.getDuration() + ' playerId: ' + this.id );
			// Clear out any non-base embedObj methods:
			if ( this.instanceOf ) {
				// Update the prev instance var used for swiching interfaces to know the previous instance.
				$( this ).data( 'previousInstanceOf', this.instanceOf );
				tmpObj = window[ 'mw.EmbedPlayer' + this.instanceOf ];
				for ( i in tmpObj ) {
					// Restore parent into local location
					if ( typeof this[ 'parent_' + i ] !== 'undefined' ) {
						this[ i ] = this[ 'parent_' + i ];
					} else {
						this[ i ] = null;
					}
				}
			}
			// Set up the new embedObj
			mw.log( 'EmbedPlayer::updatePlaybackInterface: embedding with ' + this.selectedPlayer.library );
			// Note this is not a jQuery event handler, but a call with a callback:
			this.selectedPlayer.load( function () {
				self.updateLoadedPlayerInterface( callback );
			} );
		},
		/**
		 * Update a loaded player interface by setting local methods to the
		 * updated player prototype methods
		 *
		 * @param {function}
		 * 		callback function called once player has been loaded
		 */
		updateLoadedPlayerInterface: function ( callback ) {
			var playerInterface, method,
				self = this;

			mw.log( 'EmbedPlayer::updateLoadedPlayerInterface ' + self.selectedPlayer.library + ' player loaded for ' + self.id );

			// Get embed library player Interface
			playerInterface = mw[ 'EmbedPlayer' + self.selectedPlayer.library ];

			// Build the player interface ( if the interface includes an init )
			if ( playerInterface.init ) {
				playerInterface.init();
			}

			for ( method in playerInterface ) {
				if ( typeof self[ method ] !== 'undefined' && !self[ 'parent_' + method ] ) {
					self[ 'parent_' + method ] = self[ method ];
				}
				self[ method ] = playerInterface[ method ];
			}
			// Update feature support
			self.updateFeatureSupport();
			// Update duration
			self.getDuration();
			// show player inline
			self.showPlayer();
			// Run the callback if provided
			if ( callback && $.isFunction( callback ) ) {
				callback();
			}
		},

		/**
		 * Select a player playback system
		 *
		 * @param {Object}
		 *      player Player playback system to be selected player playback
		 *      system include vlc, native, java etc.
		 */
		selectPlayer: function ( player ) {
			var self = this;
			mw.log( 'EmbedPlayer:: selectPlayer ' + player.id );
			if ( this.selectedPlayer.id !== player.id ) {
				this.selectedPlayer = player;
				this.updatePlaybackInterface( function () {
					// Hide / remove track container
					self.getInterface().find( '.track' ).remove();
					// We have to re-bind hoverIntent ( has to happen in this scope )
					if ( !self.useNativePlayerControls() && self.controls && self.controlBuilder.isOverlayControls() ) {
						self.controlBuilder.showControlBar();
						self.getInterface().hoverIntent( {
							sensitivity: 4,
							timeout: 2000,
							over: function () {
								self.controlBuilder.showControlBar();
							},
							out: function () {
								self.controlBuilder.hideControlBar();
							}
						} );
					}
				} );
			}
		},

		/**
		 * Get a time range from the media start and end time
		 *
		 * @return startNpt and endNpt time if present
		 */
		getTimeRange: function () {
			var endTime = ( this.controlBuilder.longTimeDisp ) ? '/' + mw.seconds2npt( this.getDuration() ) : '',
				defaultTimeRange = '0:00' + endTime;
			if ( !this.mediaElement ) {
				return defaultTimeRange;
			}
			if ( !this.mediaElement.selectedSource ) {
				return defaultTimeRange;
			}
			if ( !this.mediaElement.selectedSource.endNpt ) {
				return defaultTimeRange;
			}
			return this.mediaElement.selectedSource.startNpt + this.mediaElement.selectedSource.endNpt;
		},

		/**
		 * Get the duration of the embed player
		 */
		getDuration: function () {
			if (
				isNaN( this.duration ) && this.mediaElement && this.mediaElement.selectedSource &&
				typeof this.mediaElement.selectedSource.durationHint !== 'undefined'
			) {
				this.duration = this.mediaElement.selectedSource.durationHint;
			}
			return this.duration;
		},

		/**
		 * Get the player height
		 */
		getHeight: function () {
			return this.getInterface().height();
		},

		/**
		 * Get the player width
		 */
		getWidth: function () {
			return this.getInterface().width();
		},

		/**
		 * Check if the selected source is an audio element:
		 */
		isAudio: function () {
			return this.rewriteElementTagName === 'audio' ||
				( this.mediaElement && this.mediaElement.selectedSource && this.mediaElement.selectedSource.mimeType.indexOf( 'audio/' ) !== -1 );
		},

		/**
		 * Get the plugin embed html ( should be implemented by embed player interface )
		 */
		embedPlayerHTML: function () {
			return 'Error: function embedPlayerHTML should be implemented by embed player interface ';
		},

		/**
		 * Seek function ( should be implemented by embedPlayer interface
		 * playerNative, playerKplayer etc. ) embedPlayer seek only handles URL
		 * time seeks
		 * @param {Float}
		 * 			percent of the video total length to seek to
		 */
		seek: function ( percent ) {
			var self = this;
			this.seeking = true;
			// Trigger preSeek event for plugins that want to store pre seek conditions.
			$( this ).trigger( 'preSeek', percent );

			// Do argument checking:
			if ( percent < 0 ) {
				percent = 0;
			}

			if ( percent > 1 ) {
				percent = 1;
			}
			// set the playhead to the target position
			this.updatePlayHead( percent );

			// See if we should do a server side seek ( player independent )
			if ( this.supportsURLTimeEncoding() ) {
				mw.log( 'EmbedPlayer::seek:: updated serverSeekTime: ' + mw.seconds2npt( this.serverSeekTime ) +
						' currentTime: ' + self.currentTime );
				// make sure we need to seek:
				if ( self.currentTime === self.serverSeekTime ) {
					return;
				}

				this.stop();
				this.didSeekJump = true;
				// Make sure this.serverSeekTime is up-to-date:
				this.serverSeekTime = mw.npt2seconds( this.startNpt ) + parseFloat( percent * this.getDuration() );
			}
			// Run the onSeeking interface update
			// NOTE controlBuilder should really bind to html5 events rather
			// than explicitly calling it or inheriting stuff.
			this.controlBuilder.onSeek();
		},

		/**
		 * Seeks to the requested time and issues a callback when ready (should be
		 * overwritten by client that supports frame serving)
		 */
		setCurrentTime: function ( time, callback ) {
			mw.log( 'Error: EmbedPlayer, setCurrentTime not overriden' );
			if ( $.isFunction( callback ) ) {
				callback();
			}
		},

		/**
		 * On clip done action. Called once a clip is done playing
		 * TODO clean up end sequence flow
		 */
		triggeredEndDone: false,
		postSequence: false,
		onClipDone: function () {
			var self = this;

			// Don't run onclipdone if _propagateEvents is off
			if ( !self._propagateEvents ) {
				return;
			}
			mw.log( 'EmbedPlayer::onClipDone: propagate:' + self._propagateEvents + ' id:' + this.id + ' doneCount:' + this.donePlayingCount + ' stop state:' + this.isStopped() );
			// Only run stopped once:
			if ( !this.isStopped() ) {
				// set the "stopped" flag:
				this.stopped = true;

				// Show the control bar:
				this.controlBuilder.showControlBar();

				// TOOD we should improve the end event flow
				// First end event for ads or current clip ended bindings
				if ( !this.onDoneInterfaceFlag ) {
					this.stopEventPropagation();
				}

				mw.log( 'EmbedPlayer:: trigger: ended ( inteface continue pre-check: ' + this.onDoneInterfaceFlag + ' )' );
				$( this ).trigger( 'ended' );
				mw.log( 'EmbedPlayer::onClipDone:Trigged ended, continue? ' + this.onDoneInterfaceFlag );

				if ( !this.onDoneInterfaceFlag ) {
					// Restore events if we are not running the interface done actions
					this.restoreEventPropagation();
					return;
				}

				// A secondary end event for playlist and clip sequence endings
				if ( this.onDoneInterfaceFlag ) {
					// We trigger two end events to match KDP and ensure playbackComplete always comes before  playerPlayEnd
					// in content ends.
					mw.log( 'EmbedPlayer:: trigger: playbackComplete' );
					$( this ).trigger( 'playbackComplete' );
					// now trigger postEnd for( playerPlayEnd )
					mw.log( 'EmbedPlayer:: trigger: postEnded' );
					$( this ).trigger( 'postEnded' );
				}
				// if the ended event did not trigger more timeline actions run the actual stop:
				if ( this.onDoneInterfaceFlag ) {
					mw.log( 'EmbedPlayer::onDoneInterfaceFlag=true do interface done' );
					// Prevent the native "onPlay" event from propagating that happens when we rewind:
					this.stopEventPropagation();

					// Update the clip done playing count ( for keeping track of replays )
					self.donePlayingCount++;

					// Rewind the player to the start:
					// NOTE: Setting to 0 causes lags on iPad when replaying, thus setting to 0.01
					this.setCurrentTime( 0.01, function () {

						// Set to stopped state:
						self.stop();

						// Restore events after we rewind the player
						self.restoreEventPropagation();

						// Check if we have the "loop" property set
						if ( self.loop ) {
							self.stopped = false;
							self.play();
							return;
						} else {
							// make sure we are in a paused state.
							self.pause();
						}
						// Check if have a force display of the large play button
						if ( config[ 'EmbedPlayer.ForceLargeReplayButton' ] === true ) {
							self.addLargePlayBtn();
						} else {
							// Check if we should hide the large play button on end:
							if ( $( self ).data( 'hideEndPlayButton' ) || !self.useLargePlayBtn() ) {
								self.hideLargePlayBtn();
							} else {
								self.addLargePlayBtn();
							}
						}
						// An event for once the all ended events are done.
						mw.log( 'EmbedPlayer:: trigger: onEndedDone' );
						if ( !self.triggeredEndDone ) {
							self.triggeredEndDone = true;
							$( self ).trigger( 'onEndedDone', [ self.id ] );
						}
					} );
				}
			}
		},

		/**
		 * Shows the video Thumbnail, updates pause state
		 */
		showThumbnail: function () {
			mw.log( 'EmbedPlayer::showThumbnail::' + this.stopped );

			// Close Menu Overlay:
			this.controlBuilder.closeMenuOverlay();

			// update the thumbnail html:
			this.updatePosterHTML();

			this.paused = true;
			this.stopped = true;

			// Once the thumbnail is shown run the mediaReady trigger (if not using native controls)
			if ( !this.useNativePlayerControls() ) {
				mw.log( 'mediaLoaded' );
				$( this ).trigger( 'mediaLoaded' );
			}
		},

		/**
		 * Show the player
		 */
		showPlayer: function () {
			var self = this;
			mw.log( 'EmbedPlayer:: showPlayer: ' + this.id + ' interface: w:' + this.width + ' h:' + this.height );

			// Remove the player loader spinner if it exists
			this.hideSpinnerAndPlayBtn();
			// If a isPersistentNativePlayer ( overlay the controls )
			if ( !this.useNativePlayerControls() && this.isPersistentNativePlayer() ) {
				$( this ).show();
			}
			// Add controls if enabled:
			if ( this.controls ) {
				if ( this.useNativePlayerControls() ) {
					if ( this.getPlayerElement() ) {
						$( this.getPlayerElement() ).attr( 'controls', 'true' );
					}
				} else {
					this.controlBuilder.addControls();
				}
			}

			// Update Thumbnail for the "player"
			this.updatePosterHTML();

			// Update temporal url if present
			this.updateTemporalUrl();

			// Do we need to show the player?
			if ( this.displayPlayer === false ) {
				self.getVideoHolder().hide();
				self.getInterface().height( self.getComponentsHeight() );
				self.triggerHelper( 'updateLayout' );
			}

			// Update layout
			this.updateLayout();

			// Make sure we have a play btn:
			this.addLargePlayBtn();

			// Update the playerReady flag
			this.playerReadyFlag = true;
			mw.log( 'EmbedPlayer:: Trigger: playerReady' );
			// trigger the player ready event;
			$( this ).trigger( 'playerReady' );
			this.triggerWidgetLoaded();

			// Check if we want to block the player display
			if ( this[ 'data-blockPlayerDisplay' ] ) {
				this.blockPlayerDisplay();
				return;
			}

			// Check if there are any errors to be displayed:
			if ( this.getError() ) {
				this.showErrorMsg( this.getError() );
				return;
			}
			// Auto play stopped ( no playerReady has already started playback ) and if not on an iPad
			if ( this.isStopped() && this.autoplay && !mw.isIOS() ) {
				mw.log( 'EmbedPlayer::showPlayer::Do autoPlay' );
				self.play();
			}
		},

		getComponentsHeight: function () {
			var offset, height = 0;

			// Go over all playerContainer direct children with .block class
			this.getInterface().find( '.block' ).each( function () {
				height += $( this ).outerHeight( true );
			} );

			// FIXME embedPlayer should know nothing about playlist layout
			/* If we're in vertical playlist mode, and not in fullscreen add playlist height
			if( $('#container').hasClass('vertical') && ! this.controlBuilder.isInFullScreen() && this.displayPlayer ) {
				height += $('#playlistContainer').outerHeight( true );
			}
			*/

			offset = mw.isIOS() ? 5 : 0;

			return height + offset;
		},
		updateLayout: function () {
			var windowHeight, newHeight, currentHeight;

			// update image layout:
			this.applyIntrinsicAspect();
			if ( !config[ 'EmbedPlayer.IsIframeServer' ] ) {
				// Use intrensic container size
				return;
			}
			// Set window height if in iframe:
			if ( mw.isIOS() && !this.controlBuilder.isInFullScreen() ) {
				windowHeight = $( window.parent.document.getElementById( this.id ) ).height();
			} else {
				windowHeight = window.innerHeight;
			}

			newHeight = windowHeight - this.getComponentsHeight();
			currentHeight = this.getVideoHolder().height();
			// Always update videoHolder height
			if ( currentHeight !== newHeight ) {
				mw.log( 'EmbedPlayer: updateLayout:: window: ' + windowHeight + ', components: ' + this.getComponentsHeight() + ', videoHolder old height: ' + currentHeight + ', new height: ' + newHeight );
				this.getVideoHolder().height( newHeight );
			}
		},
		/**
		 * Gets a refrence to the main player interface, builds if not avaliable
		 */
		getInterface: function () {
			if ( !this.$interface ) {
				// init the control builder
				this.controlBuilder = new mw.PlayerControlBuilder( this );

				// build the interface wrapper
				this.$interface = $( this ).wrap(
					$( '<div>' )
						.addClass( 'mwPlayerContainer ' + this.class + ' ' + this.controlBuilder.playerClass )
						.removeClass( 'kskin' )
						.append(
							$( '<div>' ).addClass( 'videoHolder' )
						)
				).parent().parent();

				// pass along any inhereted style:
				if ( this.style.cssText ) {
					this.$interface[ 0 ].style.cssText = this.style.cssText;
				}
				// clear out base style
				this.style.cssText = '';

				// if not displayiung a play button, ( pass through to native player )
				if ( !this.useLargePlayBtn() ) {
					this.$interface.css( 'pointer-events', 'none' );
				}
			}
			return this.$interface;
		},

		/**
		 * Media fragments handler based on:
		 * http://www.w3.org/2008/WebVideo/Fragments/WD-media-fragments-spec/#fragment-dimensions
		 *
		 * We support seconds and npt ( normal play time )
		 *
		 * Updates the player per fragment url info if present
		 *
		 */
		updateTemporalUrl: function () {
			var times,
				sourceHash = /[^#]+$/.exec( this.getSrc() ).toString();
			if ( sourceHash.indexOf( 't=' ) === 0 ) {
				// parse the times
				times = sourceHash.substr( 2 ).split( ',' );
				if ( times[ 0 ] ) {
					// update the current time
					this.currentTime = mw.npt2seconds( times[ 0 ].toString() );
				}
				if ( times[ 1 ] ) {
					this.pauseTime = mw.npt2seconds( times[ 1 ].toString() );
					// ignore invalid ranges:
					if ( this.pauseTime < this.currentTime ) {
						this.pauseTime = null;
					}
				}
				// Update the play head
				this.updatePlayHead( this.currentTime / this.duration );
				// Update status:
				this.controlBuilder.setStatus( mw.seconds2npt( this.currentTime ) );
			}
		},
		/**
		 * Sets an error message on the player
		 *
		 * @param {string}
		 *            errorMsg
		 */
		setError: function ( errorObj ) {
			var self = this;
			if ( typeof errorObj === 'string' ) {
				this.playerError = {
					title: self.getKalturaMsg( 'ks-GENERIC_ERROR_TITLE' ),
					message: errorObj
				};
				return;

			}
			this.playerError = errorObj;
		},
		/**
		 * Gets the current player error
		 */
		getError: function () {
			if ( !$.isEmptyObject( this.playerError ) ) {
				return this.playerError;
			}
			return null;
		},

		/**
		 * Show an error message on the player
		 *
		 * @param {object}
		 *            errorObj
		 */
		showErrorMsg: function ( errorObj ) {
			var alertObj;

			// Remove a loading spinner
			this.hideSpinnerAndPlayBtn();
			if ( this.controlBuilder ) {
				if ( config[ 'EmbedPlayer.ShowPlayerAlerts' ] ) {
					alertObj = $.extend( errorObj, {
						isModal: true,
						keepOverlay: true,
						noButtons: true,
						isError: true
					} );
					this.controlBuilder.displayAlert( alertObj );
				}
			}
			return;
		},

		/**
		 * Blocks the player display by invoking an empty error msg
		 */
		blockPlayerDisplay: function () {
			this.showErrorMsg();
			this.getInterface().find( '.error' ).hide();
		},

		/**
		 * Get missing plugin html (check for user included code)
		 *
		 * @param {String}
		 *            [misssingType] missing type mime
		 */
		showPlayerError: function () {
			var $this = $( this );
			mw.log( 'EmbedPlayer::showPlayerError' );
			// Hide loader
			this.hideSpinnerAndPlayBtn();

			// Error in loading media ( trigger the mediaLoadError )
			$this.trigger( 'mediaLoadError' );

			// We don't distiguish between mediaError and mediaLoadError right now
			// TODO fire mediaError only on failed to recive audio/video  data.
			$this.trigger( 'mediaError' );

			// Check if we want to block the player display ( no error displayed )
			if ( this[ 'data-blockPlayerDisplay' ] ) {
				this.blockPlayerDisplay();
				return;
			}

			// Check if there is a more specific error:
			if ( this.getError() ) {
				this.showErrorMsg( this.getError() );
				return;
			}

			// If no error is given assume missing sources:
			this.showNoInlinePlabackSupport();
		},

		/**
		 * Show player missing sources method
		 */
		showNoInlinePlabackSupport: function () {
			var downloadUrl, $pBtn,
				self = this;

			// Check if any sources are avaliable:
			if ( this.mediaElement.sources.length === 0 ||
				!config[ 'EmbedPlayer.NotPlayableDownloadLink' ] ) {
				return;
			}
			// Set the isLink player flag:
			this.isLinkPlayer = true;
			// Update the poster and html:
			this.updatePosterHTML();

			// Make sure we have a play btn:
			this.addLargePlayBtn();

			// By default set the direct download url to the first source.
			downloadUrl = this.mediaElement.sources[ 0 ].getSrc();
			// Allow plugins to update the download url ( to point to server side tools to select
			// stream based on user agent ( i.e IE8 h.264 file, blackberry 3gp file etc )
			this.triggerHelper( 'directDownloadLink', function ( dlUrl ) {
				if ( dlUrl ) {
					downloadUrl = dlUrl;
				}
			} );
			// Set the play button to the first available source:
			$pBtn = this.getInterface().find( '.play-btn-large' )
				.attr( 'title', mw.msg( 'mwe-embedplayer-play_clip' ) )
				.show()
				.off( 'click' )
				.on( 'click', function () {
					self.triggerHelper( 'firstPlay', [ self.id ] ); // To send stats event for play
					self.triggerHelper( 'playing' );
					return true;
				} );
			if ( !$pBtn.parent( 'a' ).length ) {
				$pBtn.wrap( $( '<a>' ).attr( 'target', '_blank' ) );
			}
			$pBtn.parent( 'a' ).attr( 'href', downloadUrl );

			$( this ).trigger( 'showInlineDownloadLink' );
		},
		/**
		 * Update the video time request via a time request string
		 *
		 * @param {String}
		 *      timeRequest video time to be updated
		 */
		updateVideoTimeReq: function ( timeRequest ) {
			var timeParts = timeRequest.split( '/' );
			mw.log( 'EmbedPlayer::updateVideoTimeReq:' + timeRequest );
			this.updateVideoTime( timeParts[ 0 ], timeParts[ 1 ] );
		},

		/**
		 * Update Video time from provided startNpt and endNpt values
		 *
		 * @param {String}
		 *      startNpt the new start time in npt format ( hh:mm:ss.ms )
		 * @param {String}
		 * 		endNpt the new end time in npt format ( hh:mm:ss.ms )
		 */
		updateVideoTime: function ( startNpt, endNpt ) {
			// update media
			this.mediaElement.updateSourceTimes( startNpt, endNpt );

			// update time
			this.controlBuilder.setStatus( startNpt + '/' + endNpt );

			// reset slider
			this.updatePlayHead( 0 );

			// Reset the serverSeekTime if urlTimeEncoding is enabled
			if ( this.supportsURLTimeEncoding() ) {
				this.serverSeekTime = 0;
			} else {
				this.serverSeekTime = mw.npt2seconds( startNpt );
			}
		},

		/**
		 * Update Thumb time with npt formated time
		 *
		 * @param {String}
		 *      time NPT formated time to update thumbnail
		 */
		updateThumbTimeNPT: function ( time ) {
			this.updateThumbTime( mw.npt2seconds( time ) - parseInt( this.startOffset ) );
		},

		/**
		 * Update the thumb with a new time
		 *
		 * @param {Float}
		 *      floatSeconds Time to update the thumb to
		 */
		updateThumbTime: function ( floatSeconds ) {
			// mw.log( 'updateThumbTime:' + floatSeconds );
			if ( typeof this.orgThumSrc === 'undefined' ) {
				this.orgThumSrc = this.poster;
			}
			if ( this.orgThumSrc.indexOf( 't=' ) !== -1 ) {
				this.lastThumbUrl = mw.replaceUrlParams( this.orgThumSrc,
					{
						t: mw.seconds2npt( floatSeconds + parseInt( this.startOffset ) )
					}
				);
				if ( !this.thumbnailUpdatingFlag ) {
					this.updatePoster( this.lastThumbUrl, false );
					this.lastThumbUrl = null;
				}
			}
		},

		/**
		 * Updates the displayed thumbnail via percent of the stream
		 *
		 * @param {Float}
		 *      percent Percent of duration to update thumb
		 */
		updateThumbPerc: function ( percent ) {
			return this.updateThumbTime( ( this.getDuration() * percent ) );
		},

		/**
		 * Update the poster source
		 * @param {String}
		 * 		posterSrc Poster src url
		 */
		updatePosterSrc: function ( posterSrc ) {
			if ( !posterSrc ) {
				posterSrc = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkqAcAAIUAgUW0RjgAAAAASUVORK5CYII=';
			}
			this.poster = posterSrc;
			this.updatePosterHTML();
			this.applyIntrinsicAspect();
		},

		/**
		 * Called after sources are updated, and your ready for the player to change media
		 * @return
		 */
		changeMedia: function ( callback ) {
			var bindName,
				self = this,
				$this = $( this );
			mw.log( 'EmbedPlayer:: changeMedia ' );
			// Empty out embedPlayer object sources
			this.emptySources();

			// onChangeMedia triggered at the start of the change media commands
			$this.trigger( 'onChangeMedia' );

			// Reset first play to true, to count that play event
			this.firstPlay = true;
			// reset donePlaying count on change media.
			this.donePlayingCount = 0;
			this.triggeredEndDone = false;
			this.preSequence = false;
			this.postSequence = false;

			this.setCurrentTime( 0.01 );
			// Reset the playhead
			this.updatePlayHead( 0 );
			// update the status:
			this.controlBuilder.setStatus( this.getTimeRange() );

			// Add a loader to the embed player:
			this.pauseLoading();

			// Clear out any player error ( both via attr and object property ):
			this.setError( null );

			//	Clear out any player display blocks
			this[ 'data-blockPlayerDisplay' ] = null;
			$this.attr( 'data-blockPlayerDisplay', '' );

			// Clear out the player error div:
			this.getInterface().find( '.error' ).remove();
			this.controlBuilder.closeAlert();
			this.controlBuilder.closeMenuOverlay();

			// Restore the control bar:
			this.getInterface().find( '.control-bar' ).show();
			// Hide the play btn
			this.hideLargePlayBtn();

			// If we are change playing media add a ready binding:
			bindName = 'playerReady.changeMedia';
			$this.off( bindName ).on( bindName, function () {
				var source;
				mw.log( 'EmbedPlayer::changeMedia playerReady callback' );
				// hide the loading spinner:
				self.hideSpinnerAndPlayBtn();
				// check for an erro on change media:
				if ( self.getError() ) {
					self.showErrorMsg( self.getError() );
					return;
				}
				// Always show the control bar on switch:
				if ( self.controlBuilder ) {
					self.controlBuilder.showControlBar();
				}
				// Make sure the play button reflects the original play state
				if ( self.autoplay ) {
					self.hideLargePlayBtn();
				} else {
					self.addLargePlayBtn();
				}
				source = self.getSource();
				if ( ( self.isPersistentNativePlayer() || self.useNativePlayerControls() ) && source ) {
					// If switching a Persistent native player update the source:
					// ( stop and play won't refresh the source  )
					self.switchPlaySource( source, function () {
						self.changeMediaStarted = false;
						$this.trigger( 'onChangeMediaDone' );
						if ( self.autoplay ) {
							self.play();
						} else {
							// pause is need to keep pause sate, while
							// switch source calls .play() that some browsers require.
							// to reflect source swiches.
							self.pause();
							self.addLargePlayBtn();
						}
						if ( callback ) {
							callback();
						}
					} );
					// we are handling trigger and callback asynchronously return here.
					return;
				}

				// Reset changeMediaStarted flag
				self.changeMediaStarted = false;

				// Stop should unload the native player
				self.stop();

				// reload the player
				if ( self.autoplay ) {
					self.play();
				} else {
					self.addLargePlayBtn();
				}

				$this.trigger( 'onChangeMediaDone' );
				if ( callback ) {
					callback();
				}
			} );

			// Load new sources per the entry id via the checkPlayerSourcesEvent hook:
			$this.triggerQueueCallback( 'checkPlayerSourcesEvent', function () {
				// Start player events leading to playerReady
				self.setupSourcePlayer();
			} );
		},
		/**
		 * Checks if the current player / configuration is an image play screen:
		 */
		isImagePlayScreen: function () {
			return ( this.useNativePlayerControls() &&
				!this.isLinkPlayer &&
				mw.isIphone() &&
				config[ 'EmbedPlayer.iPhoneShowHTMLPlayScreen' ]
			);
		},
		/**
		 * Triggers widgetLoaded event - Needs to be triggered only once, at the first time playerReady is trigerred
		 */
		triggerWidgetLoaded: function () {
			if ( !this.widgetLoaded ) {
				this.widgetLoaded = true;
				mw.log( 'EmbedPlayer:: Trigger: widgetLoaded' );
				this.triggerHelper( 'widgetLoaded' );
			}
		},

		/**
		 * Updates the poster HTML
		 */
		updatePosterHTML: function () {
			var posterSrc, $vid,
				self = this,
				profile = $.client.profile();

			mw.log( 'EmbedPlayer:updatePosterHTML::' + this.id );

			if ( this.isImagePlayScreen() ) {
				this.addPlayScreenWithNativeOffScreen();
				return;
			}

			// Set by default thumb value if not found
			posterSrc = ( this.poster ) ? this.poster :
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkqAcAAIUAgUW0RjgAAAAASUVORK5CYII=';

			// Update PersistentNativePlayer poster:
			if ( this.isPersistentNativePlayer() ) {
				$vid = $( '#' + this.pid ).show();
				$vid.attr( 'poster', posterSrc );
				// Add a quick timeout hide / show ( firefox 4x bug with native poster updates )
				if ( profile.name === 'firefox' ) {
					$vid.hide();
					setTimeout( function () {
						$vid.show();
					}, 0 );
				}
			} else {
				// hide the pid if present:
				$( '#' + this.pid ).hide();
				// Poster support is not very consistent in browsers use a jpg poster image:
				$( this )
					.html(
						$( '<img>' )
							.css( {
								position: 'absolute',
								top: 0,
								left: 0,
								right: 0,
								bottom: 0
							} )
							.attr( {
								src: posterSrc
							} )
							.addClass( 'playerPoster' )
							.on( 'load', function () {
								self.applyIntrinsicAspect();
							} )
					).show();
			}
			if ( this.useLargePlayBtn() && this.controlBuilder &&
				this.height > this.controlBuilder.getComponentHeight( 'playButtonLarge' )
			) {
				this.addLargePlayBtn();
			}
		},
		/**
		 * Abstract method, must be set by player inteface
		 */
		addPlayScreenWithNativeOffScreen: function () {
			mw.log( 'Error: EmbedPlayer, Must override \'addPlayScreenWithNativeOffScreen\' with player inteface' );
			return;
		},
		/**
		 * Checks if a large play button should be displayed on the
		 * otherwise native player
		 */
		useLargePlayBtn: function () {
			if ( this.isPersistantPlayBtn() ) {
				return true;
			}
			// If we are using native controls return false:
			return !this.useNativePlayerControls();
		},
		/**
		 * Checks if the play button should stay on screen during playback,
		 * cases where a native player is dipalyed such as iPhone.
		 */
		isPersistantPlayBtn: function () {
			return ( mw.isIphone() && config[ 'EmbedPlayer.iPhoneShowHTMLPlayScreen' ] );
		},
		/**
		 * Checks if native controls should be used
		 *
		 * @return boolean true if the mwEmbed player interface should be used
		 *     false if the mwEmbed player interface should not be used
		 */
		useNativePlayerControls: function () {
			if ( this.usenativecontrols === true ) {
				return true;
			}

			if ( config[ 'EmbedPlayer.NativeControls' ] === true ) {
				return true;
			}

			// Check for special webkit property that allows inline iPhone playback:
			if ( config[ 'EmbedPlayer.WebKitPlaysInline' ] === true && mw.isIphone() ) {
				return false;
			}

			// Do some device detection devices that don't support overlays
			// and go into full screen once play is clicked:
			if ( mw.isIpod() || mw.isIphone() ) {
				return true;
			}

			// iPad can use html controls if its a persistantPlayer in the dom before loading )
			// else it needs to use native controls:
			if ( mw.isIpad() ) {
				if ( config[ 'EmbedPlayer.EnableIpadHTMLControls' ] === true ) {
					return false;
				} else {
					// Set warning that your trying to do iPad controls without
					// persistent native player:
					return true;
				}
			}
			return false;
		},
		/**
		 * Checks if the native player is persistent in the dom since the intial page build out.
		 */
		isPersistentNativePlayer: function () {
			if ( this.isLinkPlayer ) {
				return false;
			}
			// Since we check this early on sometimes the player
			// has not yet been updated to the pid location
			if ( $( '#' + this.pid ).length === 0 ) {
				return $( '#' + this.id ).hasClass( 'persistentNativePlayer' );
			}
			return $( '#' + this.pid ).hasClass( 'persistentNativePlayer' );
		},
		isTouchDevice: function () {
			return mw.isIpad() ||
			mw.isMobileChrome();
		},
		/**
		 * Hides the large play button
		 * TODO move to player controls
		 */
		hideLargePlayBtn: function () {
			if ( this.getInterface() ) {
				this.getInterface().find( '.play-btn-large' ).hide();
			}
		},
		/**
		 * Add a play button (if not already there )
		 */
		addLargePlayBtn: function () {
			// check if we are pauseLoading ( i.e switching media, seeking, etc. and don't display play btn:
			if ( this.isPauseLoading ) {
				mw.log( 'EmbedPlayer:: addLargePlayBtn ( skip play button, during load )' );
				return;
			}
			// if using native controls make sure we can click the big play button by restoring
			// interface click events:
			if ( this.useNativePlayerControls() ) {
				this.getInterface().css( 'pointer-events', 'auto' );
			}

			// iPhone in WebKitPlaysInline mode does not support clickable overlays as of iOS 5.0
			if ( config[ 'EmbedPlayer.WebKitPlaysInline' ] && mw.isIphone() ) {
				return;
			}
			if ( this.getInterface().find( '.play-btn-large' ).length ) {
				this.getInterface().find( '.play-btn-large' ).show();
			} else {
				this.getVideoHolder().append(
					this.controlBuilder.getComponent( 'playButtonLarge' )
				);
			}
		},

		getVideoHolder: function () {
			return this.getInterface().find( '.videoHolder' );
		},

		/**
		 * Abstract method,
		 * Get native player html ( should be set by mw.EmbedPlayerNative )
		 */
		getNativePlayerHtml: function () {
			return $( '<div>' )
				.css( 'width', this.getWidth() )
				.html( 'Error: Trying to get native html5 player without native support for codec' );
		},

		/**
		 * Should be set via native embed support
		 */
		applyMediaElementBindings: function () {
			mw.log( 'Warning applyMediaElementBindings should be implemented by player interface' );
			return;
		},

		/**
		 * Gets code to embed the player remotely for "share" this player links
		 */
		getSharingEmbedCode: function () {
			switch ( config[ 'EmbedPlayer.ShareEmbedMode' ] ) {
				case 'iframe':
					return this.getShareIframeObject();
				case 'videojs':
					return this.getShareEmbedVideoJs();
			}
		},

		/**
		 * Gets code to embed the player in a wiki
		 */
		getWikiEmbedCode: function () {
			if ( this.apiTitleKey ) {
				return '[[File:' + this.apiTitleKey + ']]';
			} else {
				return false;
			}
		},

		/**
		 * Get the iframe share code:
		 */
		getShareIframeObject: function () {
			// TODO move to getShareIframeSrc
			var iframeUrl = this.getIframeSourceUrl(),
				// Set up embedFrame src path
				embedCode = '&lt;iframe src=&quot;' + mw.html.escape( iframeUrl ) + '&quot; ';

			// Set width / height of embed object
			embedCode += 'width=&quot;' + this.getPlayerWidth() + '&quot; ';
			embedCode += 'height=&quot;' + this.getPlayerHeight() + '&quot; ';
			embedCode += 'frameborder=&quot;0&quot; ';
			embedCode += 'webkitAllowFullScreen mozallowfullscreen allowFullScreen';

			// Close up the embedCode tag:
			embedCode += '&gt;&lt/iframe&gt;';

			// Return the embed code
			return embedCode;
		},
		/**
		 * Gets the iframe source url
		 */
		getIframeSourceUrl: function () {
			var params, i, source,
				iframeUrl = false;
			this.triggerHelper( 'getShareIframeSrc', [ function ( localIframeSrc ) {
				if ( iframeUrl ) {
					mw.log( 'Error multiple modules binding getShareIframeSrc' );
				}
				iframeUrl = localIframeSrc;
			}, this.id ] );
			if ( iframeUrl ) {
				return iframeUrl;
			}
			// old style embed:
			iframeUrl = mw.getMwEmbedPath() + 'mwEmbedFrame.php?';
			params = { 'src[]': [] };

			// Output all the video sources:
			for ( i = 0; i < this.mediaElement.sources.length; i++ ) {
				source = this.mediaElement.sources[ i ];
				if ( source.src ) {
					params[ 'src[]' ].push( mw.absoluteUrl( source.src ) );
				}
			}
			// Output the poster attr
			if ( this.poster ) {
				params.poster = this.poster;
			}

			if ( this.duration ) {
				params.durationHint = parseFloat( this.duration );
			}
			iframeUrl += $.param( params );
			return iframeUrl;
		},
		/**
		 * Get the share embed Video tag html to share the embed code.
		 */
		getShareEmbedVideoJs: function () {
			// Set the embed tag type:
			var i, source,
				embedtag = ( this.isAudio() ) ? 'audio' : 'video',
				// Set up the mwEmbed js include:
				embedCode = '&lt;script type=&quot;text/javascript&quot; ' +
					'src=&quot;' +
					mw.html.escape(
						mw.absoluteUrl(
							mw.getMwEmbedSrc()
						)
					) + '&quot;&gt;&lt;/script&gt' +
					'&lt;' + embedtag + ' ';

			if ( this.poster ) {
				embedCode += 'poster=&quot;' +
					mw.html.escape( mw.absoluteUrl( this.poster ) ) +
					'&quot; ';
			}

			// Set the skin
			embedCode += 'class=&quot;kskin&quot; ';

			if ( this.duration ) {
				embedCode += 'durationHint=&quot;' + parseFloat( this.duration ) + '&quot; ';
			}

			if ( this.width || this.height ) {
				embedCode += 'style=&quot;';
				embedCode += ( this.width ) ? 'width:' + this.width + 'px;' : '';
				embedCode += ( this.height ) ? 'height:' + this.height + 'px;' : '';
				embedCode += '&quot; ';
			}

			// Close the video attr
			embedCode += '&gt;';

			// Output all the video sources:
			for ( i = 0; i < this.mediaElement.sources.length; i++ ) {
				source = this.mediaElement.sources[ i ];
				if ( source.src ) {
					embedCode += '&lt;source src=&quot;' +
						mw.absoluteUrl( source.src ) +
						'&quot; &gt;&lt;/source&gt;';
				}
			}
			// Close the video tag
			embedCode += '&lt;/video&gt;';

			return embedCode;
		},

		/**
		 * Base Embed Controls
		 */

		/**
		 * The Play Action
		 *
		 * Handles play requests, updates relevant states:
		 * seeking =false
		 * paused =false
		 *
		 * Triggers the play event
		 *
		 * Updates pause button Starts the "monitor"
		 */
		firstPlay: true,
		preSequence: false,
		inPreSequence: false,
		replayEventCount: 0,
		play: function () {
			var self = this,
				$this = $( this );
			// Store the absolute play time ( to track native events that should not invoke interface updates )
			mw.log( 'EmbedPlayer:: play: ' + this._propagateEvents + ' poster: ' + this.stopped );

			this.absoluteStartPlayTime = new Date().getTime();

			// Check if thumbnail is being displayed and embed html
			if ( self.isStopped() && ( self.preSequence === false || ( self.sequenceProxy && self.sequenceProxy.isInSequence === false ) ) ) {
				if ( !self.selectedPlayer ) {
					self.showPlayerError();
					return false;
				} else {
					self.embedPlayerHTML();
				}
			}
			// playing, exit stopped state:
			self.stopped = false;

			if ( !this.preSequence ) {
				this.preSequence = true;
				mw.log( 'EmbedPlayer:: trigger preSequence ' );
				this.triggerHelper( 'preSequence' );
				this.playInterfaceUpdate();
				// if we entered into ad loading return
				if ( self.sequenceProxy && self.sequenceProxy.isInSequence ) {
					mw.log( 'EmbedPlayer:: isInSequence, do NOT play content' );
					return false;
				}
			}

			// We need first play event for analytics purpose
			if ( this.firstPlay && this._propagateEvents ) {
				this.firstPlay = false;
				this.triggerHelper( 'firstPlay', [ self.id ] );
			}

			if ( this.paused === true ) {
				this.paused = false;
				// Check if we should Trigger the play event
				mw.log( 'EmbedPlayer:: trigger play event::' + !this.paused + ' events:' + this._propagateEvents );
				// trigger the actual play event:
				if ( this._propagateEvents ) {
					this.triggerHelper( 'onplay' );
				}
			}

			// If we previously finished playing this clip run the "replay hook"
			if ( this.donePlayingCount > 0 && !this.paused && this._propagateEvents ) {
				this.replayEventCount++;
				// Trigger end done on replay
				this.triggeredEndDone = false;
				if ( this.replayEventCount <= this.donePlayingCount ) {
					mw.log( 'EmbedPlayer::play> trigger replayEvent' );
					this.triggerHelper( 'replayEvent' );
				}
			}

			// If we have start time defined, start playing from that point
			if ( this.currentTime < this.startTime ) {
				$this.on( 'playing.startTime', function () {
					$this.off( 'playing.startTime' );
					if ( !mw.isIOS() ) {
						self.setCurrentTime( self.startTime );
						self.startTime = 0;
					} else {
						// iPad seeking on syncronus play event sucks
						setTimeout( function () {
							self.setCurrentTime( self.startTime, function () {
								self.play();
							} );
							self.startTime = 0;
						}, 500 );
					}
					self.startTime = 0;
				} );
			}

			this.playInterfaceUpdate();
			// If play controls are enabled continue to video content element playback:
			if ( self._playContorls ) {
				return true;
			} else {
				// return false ( Mock play event, or handled elsewhere )
				return false;
			}
		},
		/**
		 * Update the player inteface for playback
		 * TODO move to controlBuilder
		 */
		playInterfaceUpdate: function () {
			var self = this;
			mw.log( 'EmbedPlayer:: playInterfaceUpdate' );
			// Hide any overlay:
			if ( this.controlBuilder ) {
				this.controlBuilder.closeMenuOverlay();
			}
			// Hide any buttons or errors  if present:
			this.getInterface().find( '.error' ).remove();
			this.hideLargePlayBtn();

			this.getInterface().find( '.play-btn span' )
				.removeClass( 'ui-icon-play' )
				.addClass( 'ui-icon-pause' );

			this.hideSpinnerOncePlaying();

			this.getInterface().find( '.play-btn' )
				.off( 'click' )
				.on( 'click', function () {
					if ( self._playContorls ) {
						self.pause();
					}
				} )
				.attr( 'title', mw.msg( 'mwe-embedplayer-pause_clip' ) );
		},
		/**
		 * Pause player, and display a loading animation
		 * @return
		 */
		pauseLoading: function () {
			this.pause();
			this.addPlayerSpinner();
			this.isPauseLoading = true;
		},
		/**
		 * Adds a loading spinner to the player.
		 */
		addPlayerSpinner: function () {
			var sId = 'loadingSpinner_' + this.id;
			// remove any old spinner
			$( '#' + sId ).remove();
			// hide the play btn if present
			this.hideLargePlayBtn();
			// re add an absolute positioned spinner:
			$( this ).show().getAbsoluteOverlaySpinner()
				.attr( 'id', sId );
		},
		hideSpinner: function () {
			// remove the spinner
			$( '#loadingSpinner_' + this.id + ',.loadingSpinner' ).remove();
		},
		/**
		 * Hides the loading spinner
		 */
		hideSpinnerAndPlayBtn: function () {
			this.isPauseLoading = false;
			this.hideSpinner();
			// hide the play btn
			this.hideLargePlayBtn();
		},
		/**
		 * Hides the loading spinner once playing.
		 */
		hideSpinnerOncePlaying: function () {
			this._checkHideSpinner = true;
		},
		/**
		 * Base embed pause Updates the play/pause button state.
		 *
		 * There is no general way to pause the video must be overwritten by embed
		 * object to support this functionality.
		 *
		 * @param {Boolean} if the event was triggered by user action or propagated by js.
		 */
		pause: function () {
			var self = this;
			// Trigger the pause event if not already paused and using native controls:
			if ( this.paused === false ) {
				this.paused = true;
				if ( this._propagateEvents ) {
					mw.log( 'EmbedPlayer:trigger pause:' + this.paused );
					// we only trigger "onpause" to avoid event propagation to the native object method
					// i.e in jQuery ( this ).trigger('pause') also calls: this.pause();
					$( this ).trigger( 'onpause' );
				}
			}
			self.pauseInterfaceUpdate();
		},
		/**
		 * Sets the player interface to paused mode.
		 */
		pauseInterfaceUpdate: function () {
			var self = this;
			mw.log( 'EmbedPlayer::pauseInterfaceUpdate' );
			// Update the ctrl "paused state"
			this.getInterface().find( '.play-btn span' )
				.removeClass( 'ui-icon-pause' )
				.addClass( 'ui-icon-play' );

			this.getInterface().find( '.play-btn' )
				.off( 'click' )
				.on( 'click', function () {
					if ( self._playContorls ) {
						self.play();
					}
				} )
				.attr( 'title', mw.msg( 'mwe-embedplayer-play_clip' ) );
		},
		/**
		 * Maps the html5 load request. There is no general way to "load" clips so
		 * underling plugin-player libs should override.
		 */
		load: function () {
			// should be done by child (no base way to pre-buffer video)
			mw.log( 'Waring:: the load method should be overided by player interface' );
		},

		/**
		 * Base embed stop
		 *
		 * Updates the player to the stop state.
		 *
		 * Shows Thumbnail
		 * Resets Buffer
		 * Resets Playhead slider
		 * Resets Status
		 *
		 * Trigger the "doStop" event
		 */
		stop: function () {
			mw.log( 'EmbedPlayer::stop:' + this.id );
			// update the player to stopped state:
			this.stopped = true;

			// Rest the prequecne flag:
			this.preSequence = false;

			// Trigger the stop event:
			$( this ).trigger( 'doStop' );

			// no longer seeking:
			this.didSeekJump = false;

			// Reset current time and prev time and seek offset
			this.currentTime = this.previousTime = this.serverSeekTime = 0;

			this.stopMonitor();

			// pause playback ( if playing )
			if ( !this.paused ) {
				this.pause();
			}
			// Restore the play button ( if not native controls or is android )
			if ( this.useLargePlayBtn() ) {
				this.addLargePlayBtn();
				this.pauseInterfaceUpdate();
			}

			// Native player controls:
			if ( !this.isPersistentNativePlayer() ) {
				// Rewrite the html to thumbnail disp
				this.showThumbnail();
				this.bufferedPercent = 0; // reset buffer state
				this.controlBuilder.setStatus( this.getTimeRange() );
			}
			// Reset the playhead
			this.updatePlayHead( 0 );
			// update the status:
			this.controlBuilder.setStatus( this.getTimeRange() );
			// reset buffer indicator:
			this.bufferedPercent = 0;
			this.updateBufferStatus();
		},

		/**
		 * Base Embed mute
		 *
		 * Handles interface updates for toggling mute. Plug-in / player interface
		 * must handle the actual media player action
		 */
		toggleMute: function () {
			var percent;
			mw.log( 'EmbedPlayer::toggleMute> (old state:) ' + this.muted );
			if ( this.muted ) {
				this.muted = false;
				percent = this.preMuteVolume;
			} else {
				this.muted = true;
				this.preMuteVolume = this.volume;
			}
			// Change the volume and trigger the volume change so that other plugins can listen.
			this.setVolume( percent, true );
			// Update the interface
			this.setInterfaceVolume( percent );
			// trigger the onToggleMute event
			$( this ).trigger( 'onToggleMute' );
		},

		/**
		 * Update volume function ( called from interface updates )
		 *
		 * @param {number} percent Percent of full volume
		 * @param {boolean} triggerChange If the event should be triggered
		 */
		setVolume: function ( percent, triggerChange ) {
			var self = this;
			// ignore NaN percent:
			if ( isNaN( percent ) ) {
				return;
			}
			// Set the local volume attribute
			this.previousVolume = this.volume;

			this.volume = percent;

			// Un-mute if setting positive volume
			if ( percent !== 0 ) {
				this.muted = false;
			}

			// Update the playerElement volume
			this.setPlayerElementVolume( percent );
			// mw.log("EmbedPlayer:: setVolume:: " + percent + ' trigger volumeChanged: ' + triggerChange );
			if ( triggerChange ) {
				$( self ).trigger( 'volumeChanged', percent );
			}
		},

		/**
		 * Updates the interface volume
		 *
		 * TODO should move to controlBuilder
		 *
		 * @param {number} percent Percentage volume to update interface
		 */
		setInterfaceVolume: function ( percent ) {
			if ( this.supports.volumeControl &&
				this.getInterface().find( '.volume-slider' ).length
			) {
				this.getInterface().find( '.volume-slider' ).slider( 'value', percent * 100 );
			}
		},

		/**
		 * Abstract method Update volume Method must be override by plug-in / player interface
		 *
		 * @param {number} percent Percentage volume to update
		 */
		setPlayerElementVolume: function () {
			mw.log( 'Error player does not support volume adjustment' );
		},

		/**
		 * Abstract method get volume Method must be override by plug-in / player interface
		 * (if player does not override we return the abstract player value )
		 */
		getPlayerElementVolume: function () {
			// mw.log(' error player does not support getting volume property' );
			return this.volume;
		},

		/**
		 * Abstract method  get volume muted property must be overwritten by plug-in /
		 * player interface (if player does not override we return the abstract
		 * player value )
		 */
		getPlayerElementMuted: function () {
			// mw.log(' error player does not support getting mute property' );
			return this.muted;
		},

		/**
		 * Passes a fullscreen request to the controlBuilder interface
		 */
		fullscreen: function () {
			this.controlBuilder.toggleFullscreen();
		},

		/**
		 * Abstract method to be run post embedding the player Generally should be
		 * overwritten by the plug-in / player
		 */
		postEmbedActions: function () {
			return;
		},

		/**
		 * Checks the player state based on thumbnail display & paused state
		 *
		 * @return {boolean} true The player is playing
		 */
		isPlaying: function () {
			if ( this.stopped ) {
				// in stopped state
				return false;
			} else if ( this.paused ) {
				// paused state
				return false;
			} else {
				return true;
			}
		},

		/**
		 * Get Stopped state
		 *
		 * @return {boolean} The player is stopped
		 */
		isStopped: function () {
			return this.stopped;
		},
		/**
		 * Stop the play state monitor
		 */
		stopMonitor: function () {
			clearInterval( this.monitorInterval );
			this.monitorInterval = 0;
		},
		/**
		 * Start the play state monitor
		 */
		startMonitor: function () {
			this.monitor();
		},

		/**
		 * Monitor playback and update interface components. underling player classes
		 *  are responsible for updating currentTime
		 */
		monitor: function () {
			var self = this;

			// Check for current time update outside of embed player
			self.syncCurrentTime();

			// mw.log( "monitor:: " + this.currentTime + ' propagateEvents: ' +  self._propagateEvents );

			// update player status
			self.updatePlayheadStatus();

			// Keep volume proprties set outside of the embed player in sync
			self.syncVolume();

			// Make sure the monitor continues to run as long as the video is not stoped
			self.syncMonitor();

			if ( self._propagateEvents ) {

				// mw.log('trigger:monitor:: ' + this.currentTime );
				$( self ).trigger( 'monitorEvent', [ self.id ] );

				// Trigger the "progress" event per HTML5 api support
				if ( self.progressEventData ) {
					$( self ).trigger( 'progress', self.progressEventData );
				}
			}
		},
		/**
		 * Sync the monitor function
		 */
		syncMonitor: function () {
			var self = this;
			// Call monitor at this.monitorRate interval.
			// ( use setInterval to avoid stacking monitor requests )
			if ( !this.isStopped() ) {
				if ( !this.monitorInterval ) {
					this.monitorInterval = setInterval( function () {
						if ( self.monitor ) { self.monitor(); }
					}, this.monitorRate );
				}
			} else {
				// If stopped "stop" monitor:
				this.stopMonitor();
			}
		},

		/**
		 * Sync the video volume
		 */
		syncVolume: function () {
			var self = this;
			// Check if volume was set outside of embed player function
			// mw.log( ' this.volume: ' + self.volume + ' prev Volume:: ' + self.previousVolume );
			if ( Math.round( self.volume * 100 ) !== Math.round( self.previousVolume * 100 ) ) {
				self.setInterfaceVolume( self.volume );
			}
			// Update the previous volume
			self.previousVolume = self.volume;

			if ( !this.getPlayerElement() ) {
				return;
			}

			// Update the volume from the player element
			self.volume = this.getPlayerElementVolume();

			// update the mute state from the player element
			if ( self.muted !== self.getPlayerElementMuted() && !self.isStopped() ) {
				mw.log( 'EmbedPlayer::syncVolume: muted does not mach embed player' );
				self.toggleMute();
				// Make sure they match:
				self.muted = self.getPlayerElementMuted();
			}
		},

		/**
		 * Checks if the currentTime was updated outside of the getPlayerElementTime function
		 */
		syncCurrentTime: function () {
			var seekPercent,
				self = this;

			// Hide the spinner once we have time update:
			if ( self._checkHideSpinner && self.currentTime !== self.getPlayerElementTime() ) {
				self._checkHideSpinner = false;
				self.hideSpinnerAndPlayBtn();

				if ( self.isPersistantPlayBtn() ) {
					// add the play button likely iphone or native player that needs the play button on
					// non-event "exit native html5 player"
					self.addLargePlayBtn();
				} else {
					// also hide the play button ( in case it was there somehow )
					self.hideLargePlayBtn();
				}
			}

			// Check if a javascript currentTime change based seek has occurred
			if ( parseInt( self.previousTime ) !== parseInt( self.currentTime ) &&
					!this.userSlide &&
					!this.seeking &&
					!this.isStopped()
			) {
				// If the time has been updated and is in range issue a seek
				if ( self.getDuration() && self.currentTime <= self.getDuration() ) {
					seekPercent = self.currentTime / self.getDuration();
					mw.log( 'EmbedPlayer::syncCurrentTime::' + self.previousTime + ' !== ' +
						self.currentTime + ' javascript based currentTime update to ' +
						seekPercent + ' === ' + self.currentTime );
					self.previousTime = self.currentTime;
					this.seek( seekPercent );
				}
			}

			// Update currentTime via embedPlayer
			self.currentTime = self.getPlayerElementTime();

			// Update any offsets from server seek
			if ( self.serverSeekTime && self.supportsURLTimeEncoding() ) {
				self.currentTime = parseInt( self.serverSeekTime ) + parseInt( self.getPlayerElementTime() );
			}

			// Update the previousTime ( so we can know if the user-javascript changed currentTime )
			self.previousTime = self.currentTime;

			// Check for a pauseTime to stop playback in temporal media fragments
			if ( self.pauseTime && self.currentTime > self.pauseTime ) {
				self.pause();
				self.pauseTime = null;
			}
		},
		/**
		 * Updates the player time and playhead position based on currentTime
		 */
		updatePlayheadStatus: function () {
			var et, ct, endPresentationTime;
			if ( this.currentTime >= 0 && this.duration ) {
				if ( !this.userSlide && !this.seeking ) {
					if ( parseInt( this.startOffset ) !== 0 ) {
						this.updatePlayHead( ( this.currentTime - this.startOffset ) / this.duration );
						et = ( this.controlBuilder.longTimeDisp ) ? '/' + mw.seconds2npt( parseFloat( this.startOffset ) + parseFloat( this.duration ) ) : '';
						this.controlBuilder.setStatus( mw.seconds2npt( this.currentTime ) + et );
					} else {
						// use raw currentTIme for playhead updates
						ct = ( this.getPlayerElement() ) ? this.getPlayerElement().currentTime || this.currentTime : this.currentTime;
						this.updatePlayHead( ct / this.duration );
						// Only include the end time if longTimeDisp is enabled:
						et = ( this.controlBuilder.longTimeDisp ) ? '/' + mw.seconds2npt( this.duration ) : '';
						this.controlBuilder.setStatus( mw.seconds2npt( this.currentTime ) + et );
					}
				}
				// Check if we are "done"
				endPresentationTime = ( this.startOffset ) ? ( this.startOffset + this.duration ) : this.duration;
				if ( this.currentTime >= endPresentationTime && !this.isStopped() ) {
					mw.log( 'EmbedPlayer::updatePlayheadStatus > should run clip done :: ' + this.currentTime + ' > ' + endPresentationTime );
					this.onClipDone();
				}
			} else {
				// Media lacks duration just show end time
				if ( this.isStopped() ) {
					this.controlBuilder.setStatus( this.getTimeRange() );
				} else if ( this.paused ) {
					this.controlBuilder.setStatus( mw.msg( 'mwe-embedplayer-paused' ) );
				} else if ( this.isPlaying() ) {
					if ( this.currentTime && !this.duration ) { this.controlBuilder.setStatus( mw.seconds2npt( this.currentTime ) + ' /' ); } else { this.controlBuilder.setStatus( ' - - - ' ); }
				} else {
					this.controlBuilder.setStatus( this.getTimeRange() );
				}
			}
		},

		/**
		 * Abstract getPlayerElementTime function
		 */
		getPlayerElementTime: function () {
			mw.log( 'Error: getPlayerElementTime should be implemented by embed library' );
		},

		/**
		 * Abstract getPlayerElementTime function
		 */
		getPlayerElement: function () {
			mw.log( 'Error: getPlayerElement should be implemented by embed library, or you may be calling this event too soon' );
		},

		/**
		 * Update the Buffer status based on the local bufferedPercent var
		 */
		updateBufferStatus: function () {
			// Get the buffer target based for playlist vs clip
			var $buffer = this.getInterface().find( '.mw_buffer' );
			// Update the buffer progress bar (if available )
			if ( this.bufferedPercent !== 0 ) {
				// mw.log('Update buffer css: ' + ( this.bufferedPercent * 100 ) +
				// '% ' + $buffer.length );
				if ( this.bufferedPercent > 1 ) {
					this.bufferedPercent = 1;
				}
				$buffer.css( {
					width: ( this.bufferedPercent * 100 ) + '%'
				} );
				$( this ).trigger( 'updateBufferPercent', this.bufferedPercent );
			} else {
				$buffer.css( 'width', '0px' );
			}

			// if we have not already run the buffer start hook
			if ( this.bufferedPercent > 0 && !this.bufferStartFlag ) {
				this.bufferStartFlag = true;
				mw.log( 'EmbedPlayer::bufferStart' );
				$( this ).trigger( 'bufferStartEvent' );
			}

			// if we have not already run the buffer end hook
			if ( this.bufferedPercent === 1 && !this.bufferEndFlag ) {
				this.bufferEndFlag = true;
				$( this ).trigger( 'bufferEndEvent' );
			}
		},

		/**
		 * Update the player playhead
		 *
		 * @param {number} perc Value between 0 and 1 for position of playhead
		 */
		updatePlayHead: function ( perc ) {
			var $playHead, val;
			// mw.log( 'EmbedPlayer: updatePlayHead: '+ perc );
			if ( this.getInterface() ) {
				$playHead = this.getInterface().find( '.play_head' );
				if ( !this.useNativePlayerControls() && $playHead.length !== 0 && $.contains( document, $playHead[ 0 ] ) ) {
					val = Math.round( perc * 1000 );
					$playHead.slider( 'value', val );
				}
			}
			$( this ).trigger( 'updatePlayHeadPercent', perc );
		},

		/**
		 * Helper Functions for selected source
		 */

		/**
		 * Get the current selected media source or first source
		 *
		 * @param {Number}
		 *            Requested time in seconds to be passed to the server if the
		 *            server supports supportsURLTimeEncoding
		 * @return src url
		 */
		getSrc: function ( serverSeekTime ) {
			if ( serverSeekTime ) {
				this.serverSeekTime = serverSeekTime;
			}
			if ( this.currentTime && !this.serverSeekTime ) {
				this.serverSeekTime = this.currentTime;
			}

			// No media element we can't return src
			if ( !this.mediaElement ) {
				return false;
			}

			// If no source selected auto select the source:
			if ( !this.mediaElement.selectedSource ) {
				this.mediaElement.autoSelectSource();
			}

			// Return selected source:
			if ( this.mediaElement.selectedSource ) {
				// See if we should pass the requested time to the source generator:
				if ( this.supportsURLTimeEncoding() ) {
					// get the first source:
					return this.mediaElement.selectedSource.getSrc( this.serverSeekTime );
				} else {
					return this.mediaElement.selectedSource.getSrc();
				}
			}
			// No selected source return false:
			return false;
		},
		/**
		 * Return the currently selected source
		 */
		getSource: function () {
			// update the current selected source:
			this.mediaElement.autoSelectSource();
			return this.mediaElement.selectedSource;
		},
		/**
		 * Static helper to get media sources from a set of videoFiles
		 *
		 * Uses mediaElement select logic to chose a
		 * video file among a set of sources
		 *
		 * @param videoFiles
		 * @return
		 */
		getCompatibleSource: function ( videoFiles ) {
			// Convert videoFiles json into HTML element:
			// TODO mediaElement should probably accept JSON
			var myMediaElement, source,
				$media = $( '<video>' );
			$.each( videoFiles, function ( inx, source ) {
				$media.append( $( '<source>' ).attr( {
					src: source.src,
					type: source.type
				} ) );
				mw.log( 'EmbedPlayer::getCompatibleSource: add ' + source.src + ' of type:' + source.type );
			} );
			myMediaElement = new mw.MediaElement( $media[ 0 ] );
			source = myMediaElement.autoSelectSource();
			if ( source ) {
				mw.log( 'EmbedPlayer::getCompatibleSource: ' + source.getSrc() );
				return source;
			}
			mw.log( 'Error:: could not find compatible source' );
			return false;
		},
		/**
		 * If the selected src supports URL time encoding
		 *
		 * @return {boolean} The src supports url time requests
		 */
		supportsURLTimeEncoding: function () {
			var timeUrls = config[ 'EmbedPlayer.EnableURLTimeEncoding' ];

			if ( timeUrls === 'none' ) {
				return false;
			} else if ( timeUrls === 'always' ) {
				return this.mediaElement.selectedSource.URLTimeEncoding;
			} else if ( timeUrls === 'flash' ) {
				if ( this.mediaElement.selectedSource && this.mediaElement.selectedSource.URLTimeEncoding ) {
					// see if the current selected player is flash:
					return ( this.instanceOf === 'Kplayer' );
				}
			} else {
				mw.log( 'Error:: invalid config value for EmbedPlayer.EnableURLTimeEncoding:: ' + config[ 'EmbedPlayer.EnableURLTimeEncoding' ] );
			}
			return false;
		}
	};

}( mediaWiki, jQuery ) );
